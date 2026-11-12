import { v } from "convex/values";
import { internalMutation, type QueryCtx } from "./_generated/server";

// The single settings row. Throws until setup inserts it through `ensure`.
export async function loadSettings(ctx: QueryCtx) {
  const settings = await ctx.db.query("settings").first();
  if (!settings) throw new Error("settings row missing, insert one from the dashboard");
  return settings;
}

// True only for the exact controller environment value FRED_MAINTENANCE_MODE=true.
export function maintenanceMode() {
  return process.env.FRED_MAINTENANCE_MODE === "true";
}

export const ensure = internalMutation({
  args: { defaultBudgetUsd: v.number(), orgTimezone: v.string() },
  handler: async (ctx, { defaultBudgetUsd, orgTimezone }) => {
    if (await ctx.db.query("settings").first()) return false;
    if (!Number.isFinite(defaultBudgetUsd) || defaultBudgetUsd < 0) throw new Error("defaultBudgetUsd must be a nonnegative USD amount");
    try { new Intl.DateTimeFormat("en", { timeZone: orgTimezone }); }
    catch { throw new Error("orgTimezone must be an IANA timezone, such as Europe/Berlin"); }
    await ctx.db.insert("settings", { globalEnabled: false, defaultBudgetUsd, orgTimezone });
    return true;
  },
});
