import { diagnosticSnapshot, failureSummary, provider, reviewFailureHeading, type StoredDiagnosticFailure } from "@fred/contracts";
import { captureJob, capture, readSnapshot, snapshotJsonLimit } from "./diagnosticCapture";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { REPORTED_EXPIRY } from "./lease";
import { scheduleMrNote } from "./mrNotes";
import { noteKeys } from "./noteKeys";
import type { Denial } from "./policy";
import { projectCredential } from "./projectTokens";
import { jobFailure, recordFailure, safeText } from "./reviewFailures";

type Job = Doc<"reviewJobs">;

// Jobs with one status, oldest first within each provider. All providers unless `providers` narrows them.
export async function jobsWithStatus(ctx: QueryCtx, status: Job["status"], providers: readonly Job["provider"][] = provider.options) {
  const groups = await Promise.all(providers.map((provider) =>
    ctx.db.query("reviewJobs").withIndex("by_status_provider", (q) => q.eq("status", status).eq("provider", provider)).collect()));
  return groups.flat();
}

async function scheduleJobNote(ctx: MutationCtx, job: Job, key: string, body: string, failureJson?: string) {
  const project = await ctx.db.get(job.projectId);
  if (!project) throw new Error(`job ${job._id} references a missing project`);
  await scheduleMrNote(ctx, {
    key, jobId: job._id, ...(failureJson ? { failureJson } : {}),
    gitlabProjectId: project.gitlabProjectId, projectPath: project.path, mrIid: job.mrIid, provider: job.provider, body,
  });
}

// What a denial is about: a queued job at claim, or a review request at enqueue before any job exists.
type DenialSubject =
  | { job: Job }
  | { project: Doc<"projects">; mrIid: number; headSha: string; provider: Job["provider"]; developerId: Job["developerId"]; triggeredBy: string };

// Records a policy denial: the denied job status at claim, the failure row, the denial comment, and the diagnostic event.
export async function denyReview(ctx: MutationCtx, subject: DenialSubject, denial: Denial, at: number) {
  const body = `AI review not run: ${denial.reason}`;
  const event = { kind: "denied", phase: "queue", at, reason: denial.gate } as const;
  if ("job" in subject) {
    const { job } = subject;
    await ctx.db.patch(job._id, { status: "denied", denialReason: denial.reason });
    await recordFailure(ctx, jobFailure(job, { kind: "denied", reason: denial.gate, summary: denial.reason, at }));
    await scheduleJobNote(ctx, job, noteKeys.jobDenial(job._id), body);
    await captureJob(ctx, job, event);
    return;
  }
  const { project, mrIid, headSha, provider, developerId, triggeredBy } = subject;
  await scheduleMrNote(ctx, { key: noteKeys.enqueueDenial(project._id, mrIid, headSha, provider, denial.reason),
    gitlabProjectId: project.gitlabProjectId, projectPath: project.path, mrIid, provider, body });
  await recordFailure(ctx, { projectId: project._id, mrIid, provider, kind: "denied", reason: denial.gate, summary: denial.reason, developerId, triggeredBy, at });
  await capture(ctx, { gitlabProjectId: project.gitlabProjectId, projectPath: project.path, mrIid, provider }, event);
}

// Fails `job` with one failure row, one comment for its lease generation, and the failure snapshot. `diagnosticJson` is the
// worker's validated snapshot of this generation; without it the job's stored snapshot, `message`, or `reason` explains the failure.
export async function failJob(ctx: MutationCtx, job: Job, reason: NonNullable<Job["failureReason"]>, message?: string, diagnosticJson?: string) {
  if (diagnosticJson !== undefined && diagnosticJson.length > snapshotJsonLimit) throw new Error("failure snapshot too large");
  const snapshot = diagnosticJson === undefined ? readSnapshot(job.diagnosticJson) : diagnosticSnapshot.parse(JSON.parse(diagnosticJson));
  if (diagnosticJson !== undefined && snapshot?.leaseGeneration !== (job.leaseGeneration ?? 0)) throw new Error("failure lease generation mismatch");
  const failure: StoredDiagnosticFailure | undefined = snapshot?.failure
    ?? (reason === "timeout" ? { category: "timeout" } : reason === "stale" ? { category: "controller" } : undefined);
  const text = safeText(snapshot?.failure ? failureSummary(snapshot.failure) : message ?? failureSummary(failure ?? { category: "unexpected" }));
  const at = Date.now();
  const leaseGeneration = job.leaseGeneration ?? 0;
  const failureSnapshot = { ...snapshot, phase: snapshot?.phase ?? (job.resultJson ? "publish" : "context"), at,
    leaseGeneration, droppedEvents: snapshot?.droppedEvents ?? 0, ...(failure ? { failure } : {}) };
  const failureJson = JSON.stringify(failureSnapshot);
  await ctx.db.patch(job._id, { status: "failed", failureReason: reason, denialReason: text, completedAt: at, diagnosticJson: failureJson });
  await recordFailure(ctx, jobFailure(job, { kind: "failed", reason, summary: text, at, failure }));
  await scheduleJobNote(ctx, job, noteKeys.jobFailure(job._id, leaseGeneration),
    `${reviewFailureHeading}: ${text}. Remove and re-add this reviewer to retry (job ${job._id})`, failureJson);
  await captureJob(ctx, job, { kind: "failed", phase: failureSnapshot.phase, at,
    ...(reason === "stale" ? { reason: "lease_expired" } : {}), ...(failure ? { failure } : {}) });
}

// Running or publishing jobs whose lease expired, at most 32, without publishing leases stale cleanup already reported.
// Running jobs from before leases use their legacy deadline.
export async function expiredJobs(ctx: QueryCtx, status: "running" | "publishing") {
  const now = Date.now();
  const leased = await ctx.db.query("reviewJobs").withIndex("by_status_expiry", (q) =>
    (status === "running" ? q.eq("status", status).gte("leaseExpiresAt", 0) : q.eq("status", status).gt("leaseExpiresAt", REPORTED_EXPIRY)).lte("leaseExpiresAt", now)).take(32);
  const legacy = status === "running" ? await ctx.db.query("reviewJobs").withIndex("by_legacy_deadline", (q) =>
    q.eq("status", status).eq("leaseExpiresAt", undefined).gte("deadlineAt", 0).lte("deadlineAt", now)).take(32 - leased.length) : [];
  return [...leased, ...legacy];
}

// Fails analysis whose lease expired, with an accounting gap and without rerunning provider calls. Publishing jobs stay recoverable.
export async function expireAnalysis(ctx: MutationCtx) {
  const stale = await expiredJobs(ctx, "running");
  for (const job of stale) {
    await ctx.db.patch(job._id, { usageIncomplete: true, usageIncompleteReason: "analysis lease expired" });
    await failJob(ctx, job, "stale", "worker lost during analysis; usage may be incomplete");
  }
  return stale.length;
}

// The job with the bot identity and project access token a worker needs to act as FRED, or null without a usable token.
export async function claimedMetadata<J extends Job>(ctx: QueryCtx, job: J) {
  const [project, developer] = await Promise.all([ctx.db.get(job.projectId), ctx.db.get(job.developerId)]);
  if (!project || !developer) throw new Error("job references missing project or developer");
  const credential = await projectCredential(ctx, project);
  if (!credential) return null;
  return {
    ...job, kind: "review" as const,
    gitlabProjectId: project.gitlabProjectId,
    projectPath: project.path,
    gitlabUserId: developer.gitlabUserId,
    gitlabBotUserId: credential.botUserId,
    gitlabBotUserIds: credential.botUserIds,
    gitlabToken: credential.token,
    publicationAcks: job.publicationAcks ?? [],
  };
}
