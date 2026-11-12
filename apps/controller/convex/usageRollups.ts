import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

// The additive columns shared by usageDaily and usageMonthly. Cost is an integer number of micro-dollars.
const zeroAmounts = { costMicroUsd: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reviews: 0 };
export type Amounts = typeof zeroAmounts;

// Rollup cost from the ledger's float dollars. Rounded to the micro-dollar so running totals never drift.
const microUsdOf = (usd: number) => Math.round(usd * 1_000_000);

// Dollars for display and the budget gate, from rollup micro-dollars.
export const usdOf = (microUsd: number) => microUsd / 1_000_000;

function added(a: Amounts, b: Amounts): Amounts {
  return {
    costMicroUsd: a.costMicroUsd + b.costMicroUsd, inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens, outputTokens: a.outputTokens + b.outputTokens, reviews: a.reviews + b.reviews,
  };
}

// Totals of rollup rows, for the spend query's ranges and groups.
export function sumAmounts(rows: Amounts[]) {
  return rows.reduce(added, zeroAmounts);
}

type LedgerRow = Pick<Doc<"usageEvents">, "month" | "provider" | "model" | "inputTokens" | "cachedInputTokens" | "outputTokens" | "costUsd"> & { day: string };

// Adds one ledger row to usageDaily and usageMonthly in the caller's transaction, so the rollups cannot drift from the
// ledger. The job counts as one review on the day and month of its first priced row only: the first call for a job
// stamps `firstUsageDay` and increments `reviews`, later calls add amounts alone. Callers dedupe by event key before
// calling, so a retried report adds once. A correction row (`supersedes`) would have to pass the difference to the
// superseded amounts. Two workers patching the same rollup row at once is an OCC conflict Convex retries.
export async function rollUpUsage(ctx: MutationCtx, job: Doc<"reviewJobs">, row: LedgerRow) {
  const firstRow = job.firstUsageDay === undefined;
  if (firstRow) await ctx.db.patch(job._id, { firstUsageDay: row.day });
  const amounts = {
    costMicroUsd: microUsdOf(row.costUsd), inputTokens: row.inputTokens, cachedInputTokens: row.cachedInputTokens,
    outputTokens: row.outputTokens, reviews: firstRow ? 1 : 0,
  };
  const daily = await ctx.db.query("usageDaily")
    .withIndex("by_day_provider_model", (q) => q.eq("day", row.day).eq("provider", row.provider).eq("model", row.model)).unique();
  if (daily) await ctx.db.patch(daily._id, added(daily, amounts));
  else await ctx.db.insert("usageDaily", { day: row.day, provider: row.provider, model: row.model, ...amounts });
  const monthly = await ctx.db.query("usageMonthly")
    .withIndex("by_developer_month", (q) => q.eq("developerId", job.developerId).eq("month", row.month)).unique();
  if (monthly) await ctx.db.patch(monthly._id, added(monthly, amounts));
  else await ctx.db.insert("usageMonthly", { month: row.month, developerId: job.developerId, ...amounts });
}
