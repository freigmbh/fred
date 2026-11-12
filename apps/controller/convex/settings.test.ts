import { convexTest } from "convex-test";
import { expect, it } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { modules } from "./test.setup";

it("creates the settings row once with reviews off and keeps an existing row", async () => {
  const t = convexTest(schema, modules);
  expect(await t.mutation(internal.settings.ensure, { defaultBudgetUsd: 3000, orgTimezone: "Europe/Berlin" })).toBe(true);
  await t.run(async (ctx) => {
    const row = await ctx.db.query("settings").unique();
    if (row) await ctx.db.patch(row._id, { globalEnabled: true });
  });
  expect(await t.mutation(internal.settings.ensure, { defaultBudgetUsd: 50, orgTimezone: "UTC" })).toBe(false);
  const rows = await t.run((ctx) => ctx.db.query("settings").collect());
  expect(rows.map(({ globalEnabled, defaultBudgetUsd, orgTimezone }) => ({ globalEnabled, defaultBudgetUsd, orgTimezone })))
    .toEqual([{ globalEnabled: true, defaultBudgetUsd: 3000, orgTimezone: "Europe/Berlin" }]);
});

it("refuses an unknown timezone", async () => {
  const t = convexTest(schema, modules);
  await expect(t.mutation(internal.settings.ensure, { defaultBudgetUsd: 3000, orgTimezone: "Mars/Olympus" })).rejects.toThrow("IANA timezone");
});
