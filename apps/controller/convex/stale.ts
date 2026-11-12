import { internalMutation } from "./_generated/server";
import { captureJob } from "./diagnosticCapture";
import { expireAnalysis, expiredJobs } from "./jobLifecycle";
import { REPORTED_EXPIRY } from "./lease";

// Fails analysis with an expired lease and reports each expired publishing lease once. Runs every minute from crons.ts.
export const failStale = internalMutation({
  args: {},
  handler: async (ctx) => {
    const failed = await expireAnalysis(ctx);
    for (const job of await expiredJobs(ctx, "publishing")) {
      await ctx.db.patch(job._id, { leaseExpiresAt: REPORTED_EXPIRY });
      await captureJob(ctx, job, { kind: "interrupted", phase: "publish", at: Date.now(), reason: "lease_expired" });
    }
    return failed;
  },
});
