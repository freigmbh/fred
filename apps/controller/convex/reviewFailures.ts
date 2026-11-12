import { redactSecrets, secretValues, type DenialGate, type StoredDiagnosticFailure } from "@fred/contracts";
import type { WithoutSystemFields } from "convex/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { readSnapshot } from "./diagnosticCapture";

type FailureRow = WithoutSystemFields<Doc<"reviewFailures">>;

// `text` redacted, on one line, and at most 500 characters, for failure rows and comments.
export function safeText(text: string) {
  return redactSecrets(text, secretValues(process.env)).replace(/[\r\n]/g, " ").slice(0, 500);
}

// Appends one durable failure record. Rows are never patched or deleted; recovery and diagnostic pruning leave them intact.
export function recordFailure(ctx: MutationCtx, row: FailureRow) {
  return ctx.db.insert("reviewFailures", row);
}

// Builds the record for a job that failed or was denied at claim.
export function jobFailure(
  job: Doc<"reviewJobs">,
  fields: Pick<FailureRow, "at" | "summary"> & ({ kind: "failed"; reason: NonNullable<Doc<"reviewJobs">["failureReason"]>; failure?: StoredDiagnosticFailure | undefined } | { kind: "denied"; reason: DenialGate }),
): FailureRow {
  const failure = fields.kind === "failed" ? fields.failure : undefined;
  return {
    jobId: job._id, leaseGeneration: job.leaseGeneration ?? 0, projectId: job.projectId, mrIid: job.mrIid, provider: job.provider,
    developerId: job.developerId, triggeredBy: job.triggeredBy,
    kind: fields.kind, reason: fields.reason, summary: fields.summary, at: fields.at,
    ...(failure ? { failureCategory: failure.category, ...(failure.provider ? { providerCode: failure.provider.code } : {}) } : {}),
  };
}

// Builds the record for a denial or failure comment that GitLab never accepted. Undefined when the project is unknown.
export async function noteFailure(ctx: MutationCtx, note: Doc<"mrNotes">, jobId: Id<"reviewJobs"> | undefined, error: string, at: number): Promise<FailureRow | undefined> {
  const project = await ctx.db.query("projects").withIndex("by_gitlab_project", (q) => q.eq("gitlabProjectId", note.gitlabProjectId)).unique();
  if (!project) return undefined;
  const job = jobId ? await ctx.db.get(jobId) : null;
  const snapshot = readSnapshot(note.failureJson);
  return {
    ...(jobId ? { jobId } : {}), noteId: note._id, projectId: project._id, mrIid: note.mrIid, provider: note.provider,
    kind: "note_failed", reason: "delivery", summary: safeText(error), at,
    ...(snapshot ? { leaseGeneration: snapshot.leaseGeneration } : {}),
    ...(job ? { developerId: job.developerId, triggeredBy: job.triggeredBy } : {}),
  };
}
