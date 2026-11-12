import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { mutation, type QueryCtx } from "./_generated/server";
import { requireLease } from "./lease";
import { dayOf, monthOf } from "./month";
import { provider, stage } from "./schema";
import { loadSettings } from "./settings";
import { rollUpUsage } from "./usageRollups";
import { requireWorker, workerAuth } from "./workerAuth";

// Appends a uniquely identified observable usage snapshot, including late reports after lease loss, and folds it into
// the day and month rollups in the same transaction.
export const recordUsage = mutation({
  args: {
    ...workerAuth, jobId: v.id("reviewJobs"), leaseToken: v.string(), eventKey: v.string(), provider, model: v.string(), stage,
    inputTokens: v.number(), cachedInputTokens: v.number(), outputTokens: v.number(), costUsd: v.number(),
    priceTableVersion: v.string(), incomplete: v.optional(v.boolean()), fredVersion: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { workerSecret, leaseToken, ...usage } = args;
    requireWorker(workerSecret);
    const job = await reportingJob(ctx, usage.jobId, leaseToken);
    if (job.provider !== usage.provider) throw new Error("usage provider must match job provider");
    if (!usage.eventKey.trim() || !usage.model.trim() || !usage.priceTableVersion.trim()) throw new Error("usage identity must not be empty");
    for (const amount of [usage.inputTokens, usage.cachedInputTokens, usage.outputTokens]) {
      if (!Number.isSafeInteger(amount) || amount < 0) throw new Error("token amounts must be nonnegative safe integers");
    }
    if (!Number.isFinite(usage.costUsd) || usage.costUsd < 0) throw new Error("cost must be finite and nonnegative");
    const existing = await ctx.db.query("usageEvents").withIndex("by_event", (q) => q.eq("jobId", usage.jobId).eq("eventKey", usage.eventKey)).unique();
    if (existing) {
      const compared = ["provider", "model", "stage", "inputTokens", "cachedInputTokens", "outputTokens", "costUsd", "priceTableVersion"] as const;
      const matches = compared.every((key) => existing[key] === usage[key]) && Boolean(existing.incomplete) === Boolean(usage.incomplete);
      if (!matches) throw new Error("usage event key reused with different amounts");
      return existing._id;
    }
    const settings = await loadSettings(ctx);
    if (usage.incomplete) await ctx.db.patch(job._id, { usageIncomplete: true });
    const now = Date.now();
    const row = { ...usage, month: monthOf(now, settings.orgTimezone), day: dayOf(now, settings.orgTimezone) };
    const id = await ctx.db.insert("usageEvents", { ...row, developerId: job.developerId, rolledUp: true });
    await rollUpUsage(ctx, job, row);
    return id;
  },
});

// Records a known accounting gap without inventing zero-cost ledger entries.
export const markUsageIncomplete = mutation({
  args: { ...workerAuth, jobId: v.id("reviewJobs"), leaseToken: v.string(), reason: v.string() },
  handler: async (ctx, args) => {
    requireWorker(args.workerSecret);
    const job = await reportingJob(ctx, args.jobId, args.leaseToken);
    await ctx.db.patch(job._id, { usageIncomplete: true, usageIncompleteReason: args.reason });
  },
});

// Records that a stage delivered its final usage total; it never clears an explicit gap.
export const confirmUsage = mutation({
  args: { ...workerAuth, jobId: v.id("reviewJobs"), leaseToken: v.string(), stage },
  handler: async (ctx, args) => {
    requireWorker(args.workerSecret);
    const job = await reportingJob(ctx, args.jobId, args.leaseToken);
    await ctx.db.patch(job._id, { usageConfirmedStages: [...new Set([...(job.usageConfirmedStages ?? []), args.stage])] });
  },
});

// The job while `leaseToken` holds its lease, or after that owner finished it, so it can flush its last observation.
async function reportingJob(ctx: QueryCtx, jobId: Doc<"reviewJobs">["_id"], leaseToken: string) {
  return requireLease(await ctx.db.get(jobId), leaseToken, { finished: true });
}
