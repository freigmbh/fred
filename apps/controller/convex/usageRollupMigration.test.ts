import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { modules } from "./test.setup";

// convex-test keeps _creationTime monotonic from instance creation, so the clock starts early and only moves forward.
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-31T20:00:00Z"));
});
afterEach(() => vi.useRealTimers());

const amounts = { provider: "claude" as const, model: "m", stage: "detect" as const, inputTokens: 10, cachedInputTokens: 2, outputTokens: 3, priceTableVersion: "test" };

it("folds legacy ledger rows into the rollups once, oldest first, and skips rows recordUsage already rolled up", async () => {
  const t = convexTest(schema, modules);
  const { legacyJobId } = await t.run(async (ctx) => {
    await ctx.db.insert("settings", { globalEnabled: true, defaultBudgetUsd: 3000, orgTimezone: "Europe/Berlin" });
    const projectId = await ctx.db.insert("projects", { gitlabProjectId: "7", path: "group/repo" });
    const developerId = await ctx.db.insert("developers", { gitlabUserId: "42" });
    const scope = { projectId, developerId, mrIid: 1, triggeredBy: "42", provider: "claude" as const, status: "done" as const };
    const legacyJobId = await ctx.db.insert("reviewJobs", { ...scope, headSha: "A" });
    const currentJobId = await ctx.db.insert("reviewJobs", { ...scope, headSha: "B", firstUsageDay: "2026-09-02" });
    await ctx.db.insert("usageEvents", { ...amounts, jobId: legacyJobId, developerId, month: "2026-08", day: "2026-08-31", costUsd: 1.5 });
    vi.setSystemTime(new Date("2026-09-01T10:00:00Z"));
    await ctx.db.insert("usageEvents", { ...amounts, jobId: legacyJobId, developerId, month: "2026-09", costUsd: 0.25 });
    vi.setSystemTime(new Date("2026-09-02T10:00:00Z"));
    await ctx.db.insert("usageEvents", { ...amounts, jobId: currentJobId, developerId, month: "2026-09", day: "2026-09-02", costUsd: 9, rolledUp: true });
    return { legacyJobId };
  });

  expect(await t.mutation(internal.migrations.backfillUsageRollups, {})).toEqual({ patched: 2, remaining: false });
  expect(await t.mutation(internal.migrations.backfillUsageRollups, {})).toEqual({ patched: 0, remaining: false });

  expect(await t.run((ctx) => ctx.db.get(legacyJobId))).toMatchObject({ firstUsageDay: "2026-08-31" });
  expect(await t.run((ctx) => ctx.db.query("usageEvents").collect())).toMatchObject([{ rolledUp: true }, { rolledUp: true }, { rolledUp: true }]);
  expect(await t.run((ctx) => ctx.db.query("usageDaily").collect())).toMatchObject([
    { day: "2026-08-31", provider: "claude", model: "m", costMicroUsd: 1_500_000, inputTokens: 10, reviews: 1 },
    { day: "2026-09-01", provider: "claude", model: "m", costMicroUsd: 250_000, inputTokens: 10, reviews: 0 },
  ]);
  expect(await t.run((ctx) => ctx.db.query("usageMonthly").collect())).toMatchObject([
    { month: "2026-08", costMicroUsd: 1_500_000, reviews: 1 },
    { month: "2026-09", costMicroUsd: 250_000, reviews: 0 },
  ]);
});
