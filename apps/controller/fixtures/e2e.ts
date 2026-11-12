import { defaultStageModels } from "@fred/contracts";
import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { sealToken } from "./tokenVault";

export const seed = internalMutation({
  args: {},
  handler: async (ctx) => {
    if (process.env.FRED_E2E_ONLY !== "1" || await ctx.db.query("settings").first()) throw new Error("Expected a fresh E2E backend");
    await ctx.db.insert("settings", { globalEnabled: true, defaultBudgetUsd: 3000, orgTimezone: "Europe/Berlin" });
  },
});

// Connects GitLab project 1 like the dashboard does, without asking GitLab: a pipeline, bot user 901, and a token sealed with FRED_TOKEN_KEY.
// Throws unless FRED_E2E_ONLY is 1 and the backend has no projects yet.
export const connectFixture = internalMutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    if (process.env.FRED_E2E_ONLY !== "1" || await ctx.db.query("projects").first()) throw new Error("Expected a fresh E2E backend");
    const projectId = await ctx.db.insert("projects", { gitlabProjectId: "1", path: "fixtures/example", stageModels: defaultStageModels, botUserIds: ["901"] });
    await ctx.db.insert("projectTokens", { projectId, sealedToken: await sealToken(token, "1"), tokenId: 1, name: "0 FRED", scopes: ["api"], expiresAt: null,
      botUserId: "901", botUsername: "project_1_bot_e2e", accessLevel: 30, checkedAt: Date.now() });
  },
});

export const expire = internalMutation({
  args: { jobId: v.id("reviewJobs") },
  handler: async (ctx, { jobId }) => {
    if (process.env.FRED_E2E_ONLY !== "1") throw new Error("Expected E2E backend");
    await ctx.db.patch(jobId, { leaseExpiresAt: Date.now() - 1 });
  },
});

export const state = internalQuery({
  args: {},
  handler: async (ctx) => ({
    jobs: await ctx.db.query("reviewJobs").collect(), usage: await ctx.db.query("usageEvents").collect(),
    findings: await ctx.db.query("findings").collect(), notes: await ctx.db.query("mrNotes").collect(),
  }),
});
