/// <reference types="vite/client" />
import { defaultStageModels } from "@fred/contracts";
import type { TestConvex } from "convex-test";
import type { Infer } from "convex/values";
import type schema from "./schema";
import type { stageModels as pipeline } from "./schema";
import { sealToken } from "./tokenVault";

// All Convex modules for convex-test. Excludes multi-dot files like *.test.ts.
export const modules = import.meta.glob(["./**/*.*s", "!./**/*.*.*s"]);

// A valid FRED_TOKEN_KEY for tests: 32 bytes in base64. Stub it with vi.stubEnv before connecting a project.
export const testTokenKey = btoa("t".repeat(32));

// A fresh webhook delivery key for an enqueue call, so each call is a new delivery: `{ ...trigger, ...delivery() }`.
export const delivery = () => ({ deliveryKey: crypto.randomUUID() });

// The project and bot the webhook fixtures in fixtures/webhooks use. User 901 is the project's "0 FRED" bot.
export const fixtureProject = { gitlabProjectId: "7", path: "frei/flight-management" };
export const fixtureBot = { botUserId: "901", token: "glpat-fixture-project-token" };

// Connects a project the way the dashboard does, without asking GitLab: pipeline, bot history, and a sealed token.
// Needs FRED_TOKEN_KEY; returns the project ID.
export async function connectProject(t: TestConvex<typeof schema>, project = fixtureProject, bot = fixtureBot, stageModels: Infer<typeof pipeline> = defaultStageModels) {
  const sealedToken = await sealToken(bot.token, project.gitlabProjectId);
  return t.run(async (ctx) => {
    const existing = await ctx.db.query("projects").withIndex("by_gitlab_project", (q) => q.eq("gitlabProjectId", project.gitlabProjectId)).unique();
    const projectId = existing?._id ?? await ctx.db.insert("projects", project);
    const botUserIds = existing?.botUserIds ?? [];
    await ctx.db.patch(projectId, { stageModels, pipelineRevision: 1, botUserIds: botUserIds.includes(bot.botUserId) ? botUserIds : [...botUserIds, bot.botUserId] });
    const row = await ctx.db.query("projectTokens").withIndex("by_project", (q) => q.eq("projectId", projectId)).unique();
    if (row) await ctx.db.delete(row._id);
    await ctx.db.insert("projectTokens", { projectId, sealedToken, tokenId: 1, name: "0 FRED", scopes: ["api"], expiresAt: null,
      botUserId: bot.botUserId, botUsername: `project_${project.gitlabProjectId}_bot`, accessLevel: 30, checkedAt: 0 });
    return projectId;
  });
}
