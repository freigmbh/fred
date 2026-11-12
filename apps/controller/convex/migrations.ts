import { retiredProviders } from "@fred/contracts";
import { v } from "convex/values";
import { applyFindingDecision } from "./findingLifecycle";
import { internalMutation } from "./_generated/server";
import { captureJob } from "./diagnosticCapture";
import { dayOf } from "./month";
import { loadSettings } from "./settings";
import { outcomeFindings, recordOutcome } from "./reviewOutcomes";
import { rollUpUsage } from "./usageRollups";

// One-off: stamps `day` on usage rows written before the column existed, 500 per call. Repeat until `remaining` is false.
export const backfillUsageDay = internalMutation({
  args: {},
  handler: async (ctx) => {
    const settings = await loadSettings(ctx);
    const rows = await ctx.db.query("usageEvents").withIndex("by_day", (q) => q.eq("day", undefined)).take(500);
    for (const row of rows) await ctx.db.patch(row._id, { day: dayOf(row._creationTime, settings.orgTimezone) });
    return { patched: rows.length, remaining: rows.length === 500 };
  },
});

// One-off: folds ledger rows written before the rollups existed into usageDaily and usageMonthly, oldest first, 200 per
// call. Repeat until `remaining` is false. Each row is marked `rolledUp`, so a rerun or a crash mid-batch adds nothing
// twice, and rows recordUsage already rolled up are skipped. Rollups are not authoritative until this has run once.
// A job in flight at the deploy has already been counted on the day of its first post-deploy row; its older rows add
// amounts only, so that review stays in the later bucket. Accepted for the pilot, at most one job per worker slot.
export const backfillUsageRollups = internalMutation({
  args: {},
  handler: async (ctx) => {
    const settings = await loadSettings(ctx);
    const rows = await ctx.db.query("usageEvents").withIndex("by_rolled_up", (q) => q.eq("rolledUp", undefined)).take(200);
    for (const row of rows) {
      const job = await ctx.db.get(row.jobId);
      if (!job) throw new Error(`usage row ${row._id} has no job`);
      await rollUpUsage(ctx, job, { ...row, day: row.day ?? dayOf(row._creationTime, settings.orgTimezone) });
      await ctx.db.patch(row._id, { rolledUp: true });
    }
    return { patched: rows.length, remaining: rows.length === 200 };
  },
});

// One-off: writes the reviewOutcomes row of done jobs completed before jobs.complete wrote them, 10 jobs per call, oldest
// first. Pass the returned `cursor` back until `remaining` is false. Jobs that already have a row are skipped, so a rerun or a
// job completed during the backfill adds nothing twice. admin.overview under-reports the month until this has run once.
// Ten jobs keep a call under Convex's 16 MiB read limit with room for their findings, even at the 1 MiB document limit.
export const backfillReviewOutcomes = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const page = await ctx.db.query("reviewJobs").withIndex("by_status_completed", (q) => q.eq("status", "done").gte("completedAt", 0))
      .paginate({ numItems: 10, cursor: args.cursor ?? null });
    let inserted = 0;
    for (const job of page.page) {
      if (job.completedAt === undefined || await ctx.db.query("reviewOutcomes").withIndex("by_job", (q) => q.eq("jobId", job._id)).first()) continue;
      await recordOutcome(ctx, job, job.completedAt);
      inserted++;
    }
    return { inserted, cursor: page.continueCursor, remaining: !page.isDone };
  },
});

// One-off: recounts the finding fields of reviewOutcomes rows written while duplicates still counted by severity, 10 rows per
// call. Pass the returned `cursor` back until `remaining` is false. A recount equals the stored row once corrected, so a rerun
// patches nothing. Ten rows keep a call under Convex's 16 MiB read limit with room for their findings.
export const recountOutcomeFindings = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const page = await ctx.db.query("reviewOutcomes").paginate({ numItems: 10, cursor: args.cursor ?? null });
    let patched = 0;
    for (const row of page.page) {
      const counted = await outcomeFindings(ctx, row.jobId);
      const unchanged = counted.validatorRejected === row.validatorRejected
        && (["blocking", "should_fix", "nit"] as const).every((severity) => counted.findings[severity] === row.findings[severity]);
      if (unchanged) continue;
      await ctx.db.patch(row._id, counted);
      patched++;
    }
    return { patched, cursor: page.continueCursor, remaining: !page.isDone };
  },
});

// Migrates legacy published findings without changing saved review results or claiming missing history.
export const backfillFindingDisposition = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("findings").filter((q) => q.and(q.eq(q.field("disposition"), undefined),
      q.or(q.eq(q.field("status"), "posted"), q.eq(q.field("status"), "resolved")))).take(500);
    for (const finding of rows) {
      if (finding.status === "resolved") await applyFindingDecision(ctx, finding, {
        eventKey: `migration:${finding._id}`, expectedDecisionId: null, after: "fixed", reason: "Imported legacy fixed status; original decision metadata is unavailable.",
        actorId: "legacy", source: "migration", jobId: finding.jobId,
      });
      else await ctx.db.patch(finding._id, { disposition: "open" });
    }
    return { patched: rows.length, remaining: rows.length === 500 };
  },
});

// One-off after the FRED project token cutover: supersedes a batch of queued and publishing reviews of the retired Claude and
// Codex bots and fails their queued finding commands. Running reviews are left to their lease expiry. Repeat until `remaining`
// is false.
export const retireLegacyQueue = internalMutation({
  args: {},
  handler: async (ctx) => {
    const jobs = (await Promise.all(retiredProviders.flatMap((provider) => (["queued", "publishing"] as const).map((status) =>
      ctx.db.query("reviewJobs").withIndex("by_status_provider", (q) => q.eq("status", status).eq("provider", provider)).take(100))))).flat();
    for (const job of jobs) {
      await ctx.db.patch(job._id, { status: "superseded", completedAt: Date.now() });
      await captureJob(ctx, job, { kind: "superseded", phase: job.status === "queued" ? "queue" : "publish", at: Date.now(), reason: "retired_bot" });
    }
    const commands = (await Promise.all(retiredProviders.map((provider) =>
      ctx.db.query("findingCommands").withIndex("by_status_provider", (q) => q.eq("status", "queued").eq("provider", provider)).take(100)))).flat();
    for (const command of commands) await ctx.db.patch(command._id, { status: "failed", failure: "retired reviewer account" });
    return { jobs: jobs.length, commands: commands.length, remaining: jobs.length + commands.length >= 100 };
  },
});
