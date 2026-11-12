import { decisionReference, readReviewResult, dispositionOf, type PublicationEffect, type ReviewResult } from "@fred/contracts";
import { applyFindingDecision, findingRevision, isPublished } from "./findingLifecycle";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";

type ResolveEffect = Extract<PublicationEffect, { kind: "resolve" }>;
type SavedDecision = ReviewResult["findingDecisions"][number];

function findingRef(ctx: QueryCtx, id: string) {
  const normalized = ctx.db.normalizeId("findings", id);
  if (!normalized) throw new Error("invalid finding ID");
  return normalized;
}

// Validates persisted intent and ownership of every earlier finding before publication starts.
export async function validateResult(ctx: QueryCtx, job: Doc<"reviewJobs">, json: string) {
  const value: unknown = JSON.parse(json);
  const legacy = typeof value === "object" && value !== null && "resolvedFindingIds" in value;
  const result = readReviewResult(value);
  for (const decision of result.findingDecisions) {
    const id = ctx.db.normalizeId("findings", decision.findingId);
    const previous = id ? await ctx.db.get(id) : null;
    const previousJob = previous ? await ctx.db.get(previous.jobId) : null;
    const decidable = previous && (dispositionOf(previous) === "open" || (legacy && dispositionOf(previous) === "fixed"));
    if (!previous || !previousJob || !decidable ||
      previous.projectId !== job.projectId || previous.mrIid !== job.mrIid || previous.provider !== job.provider ||
      previous.jobId === job._id || previousJob._creationTime > job._creationTime ||
      !isPublished(previous) || (previous.decisionId ?? null) !== decision.expectedDecisionId) {
      throw new Error("resolved finding must belong to an earlier review of this MR by this provider");
    }
    const resolutions = result.effects.filter((effect): effect is ResolveEffect => effect.kind === "resolve" && effect.findingId === decision.findingId);
    if (previous.discussionId) {
      if (resolutions.length !== 1 || resolutions[0]!.discussionId !== previous.discussionId) throw new Error("resolution effect must target the stored discussion");
    } else if (resolutions.length !== 0) {
      throw new Error("summary-only finding has no discussion to resolve");
    }
  }
  return result;
}

// Persists every validator outcome before publication, omitting undefined fields that Convex rejects.
export async function storeResultFindings(ctx: MutationCtx, job: Doc<"reviewJobs">, result: ReviewResult) {
  const { projectId, mrIid, provider } = job;
  for (const [resultIndex, finding] of result.findings.entries()) {
    const { line, oldLine, rejectReason, discussionId, disposition, ...required } = finding;
    await ctx.db.insert("findings", {
      ...required,
      ...(disposition !== undefined ? { disposition } : {}),
      ...(line !== undefined ? { line } : {}),
      ...(oldLine !== undefined ? { oldLine } : {}),
      ...(rejectReason !== undefined ? { rejectReason } : {}),
      ...(discussionId !== undefined ? { discussionId } : {}),
      jobId: job._id, projectId, mrIid, provider, resultIndex,
    });
  }
}

export async function acknowledgeFindings(ctx: MutationCtx, job: Doc<"reviewJobs">, result: ReviewResult, effect: PublicationEffect, ids: { discussionId?: string; noteId?: string }) {
  if (effect.kind === "label") return;
  if (effect.kind === "resolve") {
    await applyReviewDecision(ctx, job, result.findingDecisions.find((decision) => decision.findingId === effect.findingId)!);
    return;
  }
  const indexes = effect.kind === "finding" ? [effect.findingIndex] : effect.findingIndexes;
  const inlineIds = effect.kind === "finding" ? { ...(ids.discussionId ? { discussionId: ids.discussionId } : {}), ...(ids.noteId ? { noteId: ids.noteId } : {}) } : {};
  const findings = await ctx.db.query("findings").withIndex("by_job", (q) => q.eq("jobId", job._id)).collect();
  for (const finding of findings) {
    if (finding.resultIndex === undefined || !indexes.includes(finding.resultIndex)) continue;
    await ctx.db.patch(finding._id, { ...(finding.status === "pending" ? { status: "posted" as const } : {}), ...inlineIds });
  }
}

export async function finishResolutions(ctx: MutationCtx, job: Doc<"reviewJobs">, result: ReviewResult) {
  for (const decision of result.findingDecisions) await applyReviewDecision(ctx, job, decision);
}

async function applyReviewDecision(ctx: MutationCtx, job: Doc<"reviewJobs">, decision: SavedDecision) {
  const finding = await ctx.db.get(findingRef(ctx, decision.findingId));
  if (!finding) throw new Error("finding missing");
  if (dispositionOf(finding) === "fixed" && decision.disposition === "fixed") return;
  await applyFindingDecision(ctx, finding, { eventKey: decisionReference(job._id, finding._id),
    expectedDecisionId: decision.expectedDecisionId, after: decision.disposition, reason: decision.reason,
    actorId: job.provider, source: "validator", jobId: job._id, headSha: job.headSha });
  await ctx.db.patch(job._id, { findingRevision: await findingRevision(ctx, job) });
}
