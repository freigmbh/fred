import { inFlightStatuses } from "@fred/contracts";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { captureJob } from "./diagnosticCapture";
import { claimCommand, queuedCommands } from "./findingCommands";
import { grantLease, leaseLive } from "./lease";
import { claimedMetadata, denyReview, expireAnalysis, failJob, jobsWithStatus } from "./jobLifecycle";
import { mrBusy } from "./mrWork";
import { checkPolicy } from "./policyInput";
import { unconnectedProject } from "./projectTokens";
import { provider } from "./schema";
import { requireWorker, workerAuth } from "./workerAuth";

type Job = Doc<"reviewJobs">;

// Ignored: only FRED's work is ever listed or claimed. Accepted because workers and the pilot deploy script still send ["fred"].
const legacyProviders = { providers: v.optional(v.array(provider)) };

// FRED's queued work and active leases, so subscribers wake when abandoned work expires.
export const listQueued = query({
  args: { ...workerAuth, ...legacyProviders },
  handler: async (ctx, args) => {
    requireWorker(args.workerSecret);
    const jobs = [...await fredJobs(ctx, inFlightStatuses), ...await queuedCommands(ctx)];
    return jobs.map(({ _id, provider, _creationTime, status, leaseExpiresAt }) => ({ _id, provider, _creationTime, status, leaseExpiresAt }));
  },
});

// Leases the oldest claimable finding command, else the oldest claimable FRED review, to `workerId`. Work of the retired bots
// is never claimed.
export const claim = mutation({
  args: { ...workerAuth, ...legacyProviders, workerId: v.string() },
  handler: async (ctx, args) => {
    requireWorker(args.workerSecret);
    if (!args.workerId.trim()) throw new Error("workerId must not be empty");
    await expireAnalysis(ctx);
    const command = await claimCommand(ctx, args.workerId);
    if (command) return command;
    const now = Date.now();
    for (const job of await fredJobs(ctx, ["queued", "publishing"])) {
      if (leaseLive(job, now)) continue;
      if (await mrBusy(ctx, job.projectId, job.mrIid, job._id)) continue;
      const newAnalysis = job.status === "queued" && job.resultJson === undefined;
      if (newAnalysis) {
        const developer = await ctx.db.get(job.developerId);
        if (!developer) throw new Error("job references missing developer");
        const policy = await checkPolicy(ctx, { developer, projectId: job.projectId, provider: job.provider, now });
        if (!policy.allowed) {
          await denyReview(ctx, { job }, policy, now);
          continue;
        }
      }
      const metadata = await claimedMetadata(ctx, job);
      if (!metadata) {
        await failJob(ctx, job, "error", unconnectedProject);
        continue;
      }
      const baseline = newAnalysis ? await lastReviewedSha(ctx, job) : undefined;
      const claim = {
        ...grantLease(job, args.workerId, now),
        ...(job.status === "queued" ? { status: newAnalysis ? "running" as const : "publishing" as const } : {}),
        ...(newAnalysis ? { claimedAt: now, ...(baseline !== undefined ? { previousReviewedSha: baseline } : {}) } : {}),
      };
      await ctx.db.patch(job._id, claim);
      await captureJob(ctx, { ...job, ...claim }, { kind: "claimed", phase: job.resultJson !== undefined ? "publish" : "context", at: now,
        ...(job.status === "publishing" ? { outcome: "recovered", reason: "lease_expired" } : {}) });
      return { ...metadata, ...claim };
    }
    return null;
  },
});

// The head of the latest completed review of the job's MR by the same provider: the incremental baseline. A skipped head has
// the same tree as the review it was compared against, so it serves equally.
async function lastReviewedSha(ctx: QueryCtx, job: Job) {
  const mrJobs = await ctx.db.query("reviewJobs").withIndex("by_mr", (q) => q.eq("projectId", job.projectId).eq("mrIid", job.mrIid)).collect();
  const completedAt = (other: Job) => other.completedAt ?? other._creationTime;
  return mrJobs
    .filter((other) => (other.status === "done" || other.status === "skipped") && other.provider === job.provider)
    .sort((a, b) => completedAt(b) - completedAt(a) || b._creationTime - a._creationTime)[0]?.headSha;
}

async function fredJobs(ctx: QueryCtx, statuses: readonly Job["status"][]) {
  const groups = await Promise.all(statuses.map((status) => jobsWithStatus(ctx, status, ["fred"])));
  return groups.flat().sort((a, b) => a._creationTime - b._creationTime);
}
