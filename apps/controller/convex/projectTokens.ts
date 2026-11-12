import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type QueryCtx } from "./_generated/server";
import { validatePipeline } from "./adminModels";
import { checkToken, setBotAvatar } from "./gitlabTokens";
import { botUserIds, projectByGitlabId, upsertProject } from "./projects";
import { stageModels } from "./schema";
import { openToken } from "./tokenVault";

// Failure text for a claimed review or finding command whose project has no usable token.
export const unconnectedProject = "FRED has no usable access token for this project. Connect the project in the FRED dashboard, then request the review again";

// The stored token of a connected project: one with a review pipeline and a token. Null for any other project.
export async function connection(ctx: QueryCtx, project: Doc<"projects">) {
  if (!project.stageModels) return null;
  return ctx.db.query("projectTokens").withIndex("by_project", (q) => q.eq("projectId", project._id)).unique();
}

// The opened token and bot users of a connected project. Null when the project is not connected or its sealed token cannot
// be opened, such as after FRED_TOKEN_KEY changed: an unreadable token counts as no token.
export async function projectCredential(ctx: QueryCtx, project: Doc<"projects">) {
  const row = await connection(ctx, project);
  if (!row) return null;
  const token = await openToken(row.sealedToken, project.gitlabProjectId).catch(() => null);
  return token === null ? null : { token, botUserId: row.botUserId, botUserIds: project.botUserIds ?? [row.botUserId] };
}

// For the webhook: the project's FRED bot user ID, null unless the project is connected, and every bot author ID.
export const identity = internalQuery({
  args: { gitlabProjectId: v.string() },
  handler: async (ctx, args) => {
    const project = await projectByGitlabId(ctx, args.gitlabProjectId);
    const row = project ? await connection(ctx, project) : null;
    return { botUserId: row?.botUserId ?? null, botAuthorIds: await botUserIds(ctx) };
  },
});

// The opened credential for controller actions that write to GitLab or verify notes. Null when the project is not connected.
export const credential = internalQuery({
  args: { gitlabProjectId: v.string() },
  handler: async (ctx, args) => {
    const project = await projectByGitlabId(ctx, args.gitlabProjectId);
    return project ? projectCredential(ctx, project) : null;
  },
});

// The pipeline a connect stores: the chosen one checked against the catalog, else the project's saved one. Throws without either.
async function connectPipeline(ctx: QueryCtx, saved: Doc<"projects">["stageModels"], chosen?: Doc<"projects">["stageModels"]) {
  const pipeline = chosen ? validatePipeline(chosen, await ctx.db.query("modelCatalog").unique()) : saved;
  if (!pipeline) throw new ConvexError({ code: "pipeline_required", message: "Choose a model and effort for both stages." });
  return pipeline;
}

// Throws when a connect's pipeline is missing or unsupported. Call it before the connect writes anything to GitLab.
export const checkConnectPipeline = internalQuery({
  args: { gitlabProjectId: v.string(), stageModels: v.optional(stageModels) },
  handler: async (ctx, args) => {
    await connectPipeline(ctx, (await projectByGitlabId(ctx, args.gitlabProjectId))?.stageModels, args.stageModels);
  },
});

const inspectionFields = {
  tokenId: v.number(), name: v.string(), scopes: v.array(v.string()), expiresAt: v.union(v.string(), v.null()),
  botUserId: v.string(), botUsername: v.string(), accessLevel: v.number(), gitlabProjectId: v.string(), path: v.string(),
};

// Connects or reconnects a project with a checked, sealed token. `stageModels` replaces the pipeline; without it the saved one
// stays, and a project without one throws `pipeline_required`.
export const store = internalMutation({
  args: { ...inspectionFields, sealedToken: v.string(), stageModels: v.optional(stageModels) },
  handler: async (ctx, args) => {
    const { gitlabProjectId, path, sealedToken, stageModels: pipeline, ...metadata } = args;
    const project = await upsertProject(ctx, { gitlabProjectId, path });
    const chosen = await connectPipeline(ctx, project.stageModels, pipeline);
    const botUserIds = project.botUserIds ?? [];
    await ctx.db.patch(project._id, {
      ...(pipeline ? { stageModels: chosen, pipelineRevision: (project.pipelineRevision ?? 0) + 1 } : {}),
      ...(botUserIds.includes(metadata.botUserId) ? {} : { botUserIds: [...botUserIds, metadata.botUserId] }),
    });
    const existing = await ctx.db.query("projectTokens").withIndex("by_project", (q) => q.eq("projectId", project._id)).unique();
    const row = { projectId: project._id, sealedToken, ...metadata, checkedAt: Date.now() };
    if (existing) await ctx.db.replace(existing._id, row);
    else await ctx.db.insert("projectTokens", row);
    return { projectId: project._id };
  },
});

// Opened tokens of every stored token row, or of one project's, for token checks. `token` is null when it cannot be opened.
export const connected = internalQuery({
  args: { projectId: v.optional(v.id("projects")) },
  handler: async (ctx, args) => {
    const projectId = args.projectId;
    const rows = projectId === undefined ? await ctx.db.query("projectTokens").collect()
      : await ctx.db.query("projectTokens").withIndex("by_project", (q) => q.eq("projectId", projectId)).collect();
    return Promise.all(rows.map(async (row) => {
      const project = await ctx.db.get(row.projectId);
      const token = project ? await openToken(row.sealedToken, project.gitlabProjectId).catch(() => null) : null;
      return { tokenRowId: row._id, token, gitlabProjectId: project?.gitlabProjectId ?? null, botUserId: row.botUserId };
    }));
  },
});

// Stores the outcome of one token check: fresh metadata, or the problem the admin should fix.
export const recordCheck = internalMutation({
  args: { tokenRowId: v.id("projectTokens"), problem: v.optional(v.string()),
    inspection: v.optional(v.object({ tokenId: v.number(), name: v.string(), scopes: v.array(v.string()), expiresAt: v.union(v.string(), v.null()), accessLevel: v.number() })) },
  handler: async (ctx, args) => {
    if (!(await ctx.db.get(args.tokenRowId))) return;
    await ctx.db.patch(args.tokenRowId, { ...args.inspection, checkedAt: Date.now(), problem: args.problem });
  },
});

// Rechecks every stored token with GitLab and records each outcome. Scheduled in crons.ts.
export const checkAll = internalAction({
  args: {},
  handler: async (ctx) => {
    for (const row of await ctx.runQuery(internal.projectTokens.connected, {})) {
      await ctx.runMutation(internal.projectTokens.recordCheck, { tokenRowId: row.tokenRowId, ...await checkToken(row.token, row.gitlabProjectId, row.botUserId) });
    }
  },
});

// Sets FRED's face on every connected bot and returns the GitLab project IDs whose bot kept its old avatar.
// Run once with `convex run projectTokens:setAllAvatars` for projects connected before connecting set the avatar.
export const setAllAvatars = internalAction({
  args: {},
  handler: async (ctx) => {
    const failed: string[] = [];
    for (const row of await ctx.runQuery(internal.projectTokens.connected, {})) {
      if (!row.token || !(await setBotAvatar(row.token))) failed.push(row.gitlabProjectId ?? String(row.tokenRowId));
    }
    return failed;
  },
});
