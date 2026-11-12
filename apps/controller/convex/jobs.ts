import { dispositionOf, readReviewResult } from "@fred/contracts";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { findingRevision, findingsFor, isPublished, publicationCurrent } from "./findingLifecycle";
import { acknowledgeFindings, finishResolutions, storeResultFindings, validateResult } from "./jobFindings";
import { failJob } from "./jobLifecycle";
import { captureJob } from "./diagnosticCapture";
import { finishedBy, lastOwner, LEASE_MS, requireLease } from "./lease";
import { recordOutcome, savedResult } from "./reviewOutcomes";
import { failureReason } from "./schema";
import { requireWorker, workerAuth } from "./workerAuth";
export { claim, listQueued } from "./jobQueue";
export { recordUsage, markUsageIncomplete, confirmUsage } from "./jobUsage";

const leaseArgs = { ...workerAuth, jobId: v.id("reviewJobs"), leaseToken: v.string() };

async function ownedJob(ctx: QueryCtx, jobId: Id<"reviewJobs">, leaseToken: string) {
  return requireLease(await ctx.db.get(jobId), leaseToken);
}

// The immutable result a publishing job saved at the running-to-publishing transition.
function savedPublication(job: Doc<"reviewJobs">) {
  const result = job.status === "publishing" ? savedResult(job) : null;
  if (!result) throw new Error("job has no saved publication");
  return result;
}

const canonical = (resultJson: string) => JSON.stringify(readReviewResult(JSON.parse(resultJson)));

export const heartbeat = mutation({
  args: leaseArgs,
  handler: async (ctx, args) => {
    requireWorker(args.workerSecret);
    const job = await ownedJob(ctx, args.jobId, args.leaseToken);
    const leaseExpiresAt = Date.now() + LEASE_MS;
    await ctx.db.patch(job._id, { leaseExpiresAt });
    return { leaseExpiresAt, publicationCurrent: job.resultJson === undefined || await publicationCurrent(ctx, job) };
  },
});

export const previousFindings = query({
  args: { ...workerAuth, jobId: v.id("reviewJobs") },
  handler: async (ctx, args) => {
    requireWorker(args.workerSecret);
    const job = await ctx.db.get(args.jobId);
    if (!job) throw new Error("job not found");
    const findings = await findingsFor(ctx, job);
    return findings.filter((finding) => finding.jobId !== job._id);
  },
});

export const saveResult = mutation({
  args: { ...leaseArgs, resultJson: v.string(), fredVersion: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireWorker(args.workerSecret);
    const job = await ownedJob(ctx, args.jobId, args.leaseToken);
    if (job.resultJson !== undefined) {
      if (canonical(job.resultJson) !== canonical(args.resultJson)) throw new Error("publication result is immutable");
      return;
    }
    const result = await validateResult(ctx, job, args.resultJson);
    const resultJson = JSON.stringify(result);
    if (job.status !== "running") throw new Error("analysis already finalized");
    await storeResultFindings(ctx, job, result);
    await ctx.db.patch(job._id, { resultJson, fredVersion: args.fredVersion, status: "publishing", publicationAcks: [], findingRevision: await findingRevision(ctx, job) });
    await captureJob(ctx, job, { kind: "phase_started", phase: "publish", at: Date.now() });
  },
});

export const ackPublication = mutation({
  args: { ...leaseArgs, effectKey: v.string(), discussionId: v.optional(v.string()), noteId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireWorker(args.workerSecret);
    const job = await ownedJob(ctx, args.jobId, args.leaseToken);
    const result = savedPublication(job);
    const acks = job.publicationAcks ?? [];
    const existing = acks.find((ack) => ack.key === args.effectKey);
    if (existing) {
      if (existing.discussionId !== args.discussionId || existing.noteId !== args.noteId) throw new Error("publication acknowledgement changed");
      return;
    }
    const effect = result.effects[acks.length];
    if (!effect || effect.key !== args.effectKey) throw new Error("publication effects must be acknowledged in order");
    if ((effect.kind === "resolve" || effect.kind === "label") && !(await publicationCurrent(ctx, job))) throw new Error("publication finding revision is outdated");
    const ids = { ...(args.discussionId ? { discussionId: args.discussionId } : {}), ...(args.noteId ? { noteId: args.noteId } : {}) };
    await acknowledgeFindings(ctx, job, result, effect, ids);
    await ctx.db.patch(job._id, {
      publicationAcks: [...acks, { key: args.effectKey, ...ids }],
      ...(effect.kind === "summary" && args.noteId ? { summaryNoteId: args.noteId } : {}),
    });
    await captureJob(ctx, job, { kind: "publication_acknowledged", phase: "publish", at: Date.now(), effect: effect.kind, effectIndex: acks.length });
  },
});

export const complete = mutation({
  args: leaseArgs,
  handler: async (ctx, args) => {
    requireWorker(args.workerSecret);
    if (finishedBy(await ctx.db.get(args.jobId), args.leaseToken, "done")) return;
    const job = await ownedJob(ctx, args.jobId, args.leaseToken);
    const result = savedPublication(job);
    if ((job.publicationAcks ?? []).length !== result.effects.length) throw new Error("publication is incomplete");
    if (!(await publicationCurrent(ctx, job))) throw new Error("publication finding revision is outdated");
    await finishResolutions(ctx, job, result);
    const completedAt = Date.now();
    await ctx.db.patch(job._id, { status: "done", completedAt });
    await recordOutcome(ctx, job, completedAt);
    await captureJob(ctx, job, { kind: "completed", phase: "complete", at: completedAt });
  },
});

export const supersede = mutation({
  args: leaseArgs,
  handler: async (ctx, args) => {
    requireWorker(args.workerSecret);
    if (finishedBy(await ctx.db.get(args.jobId), args.leaseToken, "superseded")) return;
    const job = await ownedJob(ctx, args.jobId, args.leaseToken);
    await ctx.db.patch(job._id, { status: "superseded", completedAt: Date.now() });
    await captureJob(ctx, job, { kind: "superseded", phase: job.status === "publishing" ? "publish" : "context", at: Date.now(), reason: "new_head" });
  },
});

// A completed review validated every open finding against its head, and the skipped head has that same tree. A review that failed or was superseded after posting gives no such guarantee.
async function openFindingFromIncompleteReview(ctx: QueryCtx, job: Doc<"reviewJobs">) {
  for (const finding of await findingsFor(ctx, job)) {
    if (!isPublished(finding) || dispositionOf(finding) !== "open") continue;
    if ((await ctx.db.get(finding.jobId))?.status !== "done") return true;
  }
  return false;
}

// Ends analysis that found no changes since the baseline without a result. Returns skipped: false, leaving the job running, when an open finding still needs validation.
export const skip = mutation({
  args: leaseArgs,
  handler: async (ctx, args) => {
    requireWorker(args.workerSecret);
    if (finishedBy(await ctx.db.get(args.jobId), args.leaseToken, "skipped")) return { skipped: true };
    const job = await ownedJob(ctx, args.jobId, args.leaseToken);
    if (job.status !== "running" || job.resultJson !== undefined) throw new Error("only unfinished analysis can be skipped");
    if (await openFindingFromIncompleteReview(ctx, job)) return { skipped: false };
    await ctx.db.patch(job._id, { status: "skipped", completedAt: Date.now() });
    await captureJob(ctx, job, { kind: "skipped", phase: "context", at: Date.now(), reason: "unchanged" });
    return { skipped: true };
  },
});

export const fail = mutation({
  args: { ...leaseArgs, failureReason, message: v.optional(v.string()), diagnosticJson: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireWorker(args.workerSecret);
    if (finishedBy(await ctx.db.get(args.jobId), args.leaseToken, "failed")) return;
    const job = await ownedJob(ctx, args.jobId, args.leaseToken);
    await failJob(ctx, job, args.failureReason, args.message, args.diagnosticJson);
  },
});

// Resolves an ambiguous saveResult response without discarding durable publication work.
export const interruptAnalysis = mutation({
  args: { ...leaseArgs, message: v.optional(v.string()), diagnosticJson: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireWorker(args.workerSecret);
    const job = lastOwner(await ctx.db.get(args.jobId), args.leaseToken);
    if (job.status !== "running") return;
    const message = args.message ?? "analysis interrupted; usage may be incomplete";
    await ctx.db.patch(job._id, { usageIncomplete: true, usageIncompleteReason: message });
    await failJob(ctx, job, "error", message, args.diagnosticJson);
  },
});
