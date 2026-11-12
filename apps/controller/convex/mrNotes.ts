import { v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { capture } from "./diagnosticCapture";
import { gitlabRetryDelaysMs } from "./gitlabRest";
import { noteJobId } from "./noteKeys";
import { noteFailure, recordFailure } from "./reviewFailures";
import { mrNoteFields } from "./schema";

const note = v.object(mrNoteFields);
const noteOutcome = { sent: "sent", failed: "failure", pending: "retry" } as const;

// Queues one comment for delivery as the project's FRED bot. Does nothing when a note with the same key exists; noteKeys
// builds every key.
export async function scheduleMrNote(ctx: MutationCtx, args: Infer<typeof note>) {
  const existing = await ctx.db.query("mrNotes").withIndex("by_key", (q) => q.eq("key", args.key)).unique();
  if (existing) return;
  const noteId = await ctx.db.insert("mrNotes", { ...args, status: "pending", attempts: 0 });
  await ctx.scheduler.runAfter(0, internal.gitlabApi.postMrNote, { noteId });
}

export const get = internalQuery({
  args: { noteId: v.id("mrNotes") },
  handler: (ctx, args) => ctx.db.get(args.noteId),
});

export const retryFailed = internalMutation({
  args: { noteId: v.id("mrNotes") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.noteId);
    if (!row || row.status !== "failed") throw new Error("comment delivery must be failed before retrying");
    await ctx.db.patch(row._id, { status: "pending", attempts: 0, lastError: undefined });
    await ctx.scheduler.runAfter(0, internal.gitlabApi.postMrNote, args);
  },
});

export const recordAttempt = internalMutation({
  args: {
    noteId: v.id("mrNotes"),
    attempt: v.number(),
    error: v.optional(v.string()),
    retryable: v.boolean(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.noteId);
    if (!row || row.status !== "pending" || args.attempt !== row.attempts + 1) return;
    const failed = args.error !== undefined;
    const delay = failed && args.retryable ? gitlabRetryDelaysMs[args.attempt - 1] : undefined;
    const status = !failed ? "sent" : delay === undefined ? "failed" : "pending";
    await ctx.db.patch(row._id, { status, attempts: args.attempt, lastError: args.error });
    if (delay !== undefined) await ctx.scheduler.runAfter(delay, internal.gitlabApi.postMrNote, { noteId: row._id });
    const jobId = noteJobId(ctx, row);
    if (status === "failed") {
      const failure = await noteFailure(ctx, row, jobId, args.error ?? "delivery failed", Date.now());
      if (failure) await recordFailure(ctx, failure);
    }
    await capture(ctx, { jobId, gitlabProjectId: row.gitlabProjectId, mrIid: row.mrIid, provider: row.provider },
      { kind: "note_attempt", phase: "publish", at: Date.now(), outcome: noteOutcome[status] });
  },
});
