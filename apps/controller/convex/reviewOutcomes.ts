import { readReviewResult } from "@fred/contracts";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";

type Job = Doc<"reviewJobs">;

// The immutable result saved at the running-to-publishing transition, null before it. Throws when the stored JSON no longer
// reads, because saveResult validated it.
export function savedResult(job: Pick<Job, "resultJson">) {
  return job.resultJson ? readReviewResult(JSON.parse(job.resultJson)) : null;
}

// The verdict the bot published, from the label effect stored with the result: clean, findings, or null without a result.
export function verdictOf(job: Job) {
  const label = savedResult(job)?.effects.find((effect) => effect.kind === "label");
  if (label?.kind !== "label") return null;
  return label.label.endsWith("::clean") ? "clean" as const : "findings" as const;
}

// Findings of one review by severity, with validator rejects and duplicates apart since they never reach GitLab. Outcome
// rows, the queue, the Reviews table, and the Reviews totals all count with it.
export async function findingCounts(ctx: Pick<QueryCtx, "db">, jobId: Id<"reviewJobs">) {
  const counts = { blocking: 0, should_fix: 0, nit: 0, rejected: 0, duplicate: 0 };
  for (const finding of await ctx.db.query("findings").withIndex("by_job", (q) => q.eq("jobId", jobId)).collect()) {
    if (finding.status === "rejected" || finding.status === "duplicate") counts[finding.status]++;
    else counts[finding.severity]++;
  }
  return counts;
}

// The finding fields of a job's reviewOutcomes row: accepted findings by severity and validator rejects. Duplicates count in neither.
export async function outcomeFindings(ctx: Pick<QueryCtx, "db">, jobId: Id<"reviewJobs">) {
  const { blocking, should_fix, nit, rejected } = await findingCounts(ctx, jobId);
  return { findings: { blocking, should_fix, nit }, validatorRejected: rejected };
}

// Inserts the reviewOutcomes row of a job completed at `completedAt`. Called once per job, by jobs.complete and the backfill,
// which skips jobs that have a row.
export async function recordOutcome(ctx: MutationCtx, job: Job, completedAt: number) {
  const latency = job.claimedAt === undefined ? {}
    : { claimWaitMs: Math.round(job.claimedAt - job._creationTime), runMs: Math.round(completedAt - job.claimedAt) };
  await ctx.db.insert("reviewOutcomes", {
    jobId: job._id, provider: job.provider, completedAt, clean: verdictOf(job) === "clean", ...await outcomeFindings(ctx, job._id), ...latency,
  });
}
