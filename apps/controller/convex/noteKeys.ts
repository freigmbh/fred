import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

// Delivery keys of mrNotes rows. Scheduling a note whose key exists does nothing, so each key names exactly one comment.
// Keys are stored, so a format change must keep reading the old one.
export const noteKeys = {
  // The denial of a job at claim.
  jobDenial: (jobId: Id<"reviewJobs">) => jobId,
  // One failure comment per failed lease generation of a job.
  jobFailure: (jobId: Id<"reviewJobs">, leaseGeneration: number) => `${jobId}:failure:${leaseGeneration}`,
  // A denial at enqueue, before any job exists. A repeated request with the same denial reason posts nothing new.
  enqueueDenial: (projectId: Id<"projects">, mrIid: number, headSha: string, provider: Doc<"reviewJobs">["provider"], reason: string) =>
    JSON.stringify([projectId, mrIid, headSha, provider, reason]),
  // The rejection of a finding command, posted at most once per command note.
  commandRejection: (projectId: Id<"projects">, noteId: string) => `finding-command:${projectId}:${noteId}`,
  // One failure comment per failed lease generation of a finding command.
  commandFailure: (projectId: Id<"projects">, noteId: string, leaseGeneration: number) => `finding-command:${projectId}:${noteId}:failure:${leaseGeneration}`,
  // A finding command note that could not be verified.
  commandVerification: (receiptId: Id<"findingCommandRequests">) => `finding-command-verification:${receiptId}`,
};

// The job a note belongs to. Notes from before `jobId` was stored carry it only as their key.
export function noteJobId(ctx: QueryCtx, note: Doc<"mrNotes">) {
  return note.jobId ?? ctx.db.normalizeId("reviewJobs", note.key) ?? undefined;
}
