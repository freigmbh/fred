import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { monthOf } from "./month";
import { evaluatePolicy } from "./policy";
import { loadSettings, maintenanceMode } from "./settings";
import { usdOf } from "./usageRollups";

// The developer's recorded spend in a yyyy-mm month, from the usageMonthly rollup. One document read per gate check.
async function monthSpendUsd(ctx: QueryCtx, developerId: Id<"developers">, month: string) {
  const row = await ctx.db
    .query("usageMonthly")
    .withIndex("by_developer_month", (q) => q.eq("developerId", developerId).eq("month", month))
    .unique();
  return usdOf(row?.costMicroUsd ?? 0);
}

// Loads the stored inputs of one policy decision and evaluates it. Called at enqueue and at new-analysis claim.
export async function checkPolicy(
  ctx: QueryCtx,
  args: { developer: Doc<"developers">; projectId: Id<"projects">; provider: Doc<"reviewJobs">["provider"]; now: number },
) {
  const settings = await loadSettings(ctx);
  const month = monthOf(args.now, settings.orgTimezone);
  const [projectPolicy, budget, spend] = await Promise.all([
    ctx.db
      .query("projectPolicies")
      .withIndex("by_project_provider", (q) => q.eq("projectId", args.projectId).eq("provider", args.provider))
      .unique(),
    ctx.db
      .query("budgets")
      .withIndex("by_developer", (q) => q.eq("developerId", args.developer._id))
      .unique(),
    monthSpendUsd(ctx, args.developer._id, month),
  ]);
  return evaluatePolicy({
    maintenanceMode: maintenanceMode(),
    globalEnabled: settings.globalEnabled,
    developer: args.developer,
    projectDeniesProvider: projectPolicy?.allowed === false,
    monthSpendUsd: spend,
    budgetUsd: budget?.monthlyUsd ?? settings.defaultBudgetUsd,
    month,
  });
}
