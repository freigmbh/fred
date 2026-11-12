import { defaultStageModels } from "@fred/contracts";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, mutation, query, type QueryCtx } from "./_generated/server";
import { adminAuth, requireAdmin } from "./adminAuth";
import { validatePipeline } from "./adminModels";
import { gitlabWebUrl } from "./gitlabConfig";
import { checkToken, ensureReviewLabels, inspectProjectToken, setBotAvatar } from "./gitlabTokens";
import { stageModels } from "./schema";
import { sealToken } from "./tokenVault";

// Token metadata the dashboard shows.
function tokenSummary(row: Doc<"projectTokens">) {
  return {
    name: row.name, botUsername: row.botUsername, botUserId: row.botUserId, scopes: row.scopes, accessLevel: row.accessLevel,
    expiresAt: row.expiresAt, checkedAt: row.checkedAt, problem: row.problem ?? null,
  };
}

async function projectRow(ctx: QueryCtx, project: Doc<"projects">) {
  const [token, latest] = await Promise.all([
    ctx.db.query("projectTokens").withIndex("by_project", (q) => q.eq("projectId", project._id)).unique(),
    ctx.db.query("reviewJobs").withIndex("by_project", (q) => q.eq("projectId", project._id)).order("desc").first(),
  ]);
  return {
    projectId: project._id, gitlabProjectId: project.gitlabProjectId, path: project.path,
    stageModels: project.stageModels ?? null, pipelineRevision: project.pipelineRevision ?? 0, collectTranscripts: project.collectTranscripts ?? false,
    token: token ? tokenSummary(token) : null, lastReviewAt: latest?._creationTime ?? null,
  };
}

// Every project FRED knows, connected ones first, with token health, pipeline, the model catalog for the pipeline editor,
// and the pipeline that prefills a first connect.
export const projects = query({
  args: adminAuth,
  handler: async (ctx, args) => {
    requireAdmin(args.adminSecret);
    const [rows, catalog] = await Promise.all([
      ctx.db.query("projects").collect().then((all) => Promise.all(all.map((project) => projectRow(ctx, project)))),
      ctx.db.query("modelCatalog").unique(),
    ]);
    rows.sort((a, b) => Number(b.token !== null) - Number(a.token !== null) || a.path.localeCompare(b.path));
    return {
      now: Date.now(), gitlabUrl: gitlabWebUrl(),
      catalog: catalog?.models ?? [], fetchedAt: catalog?.fetchedAt ?? null, defaultPipeline: defaultStageModels, projects: rows,
    };
  },
});

// Checks a pasted project access token with GitLab, creates missing review labels, stores the sealed token, and sets FRED's
// face as the bot's avatar. A first connect needs `stageModels`; passing `gitlabProjectId` makes a token replacement refuse
// another project's token. `avatarSet` is false when GitLab refused the avatar; the project is connected either way.
export const connectProject = action({
  args: { ...adminAuth, token: v.string(), stageModels: v.optional(stageModels), gitlabProjectId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ projectId: Id<"projects">; path: string; createdLabels: string[]; avatarSet: boolean }> => {
    requireAdmin(args.adminSecret);
    const token = args.token.trim();
    const found = await inspectProjectToken(token);
    if (args.gitlabProjectId !== undefined && found.gitlabProjectId !== args.gitlabProjectId) {
      throw new ConvexError({ code: "project_token", message: `This token belongs to ${found.path}, not to the project you are replacing.` });
    }
    const pipeline = args.stageModels ? { stageModels: args.stageModels } : {};
    await ctx.runQuery(internal.projectTokens.checkConnectPipeline, { gitlabProjectId: found.gitlabProjectId, ...pipeline });
    const createdLabels = await ensureReviewLabels(token, found.gitlabProjectId);
    const sealedToken = await sealToken(token, found.gitlabProjectId);
    const { projectId } = await ctx.runMutation(internal.projectTokens.store, {
      ...found, sealedToken, ...pipeline,
    });
    return { projectId, path: found.path, createdLabels, avatarSet: await setBotAvatar(token) };
  },
});

// Rechecks one connected token with GitLab now and stores the result the periodic check would.
export const checkProject = action({
  args: { ...adminAuth, projectId: v.id("projects") },
  handler: async (ctx, args): Promise<{ problem: string | null }> => {
    requireAdmin(args.adminSecret);
    const [row] = await ctx.runQuery(internal.projectTokens.connected, { projectId: args.projectId });
    if (!row) throw new ConvexError({ code: "project_token", message: "This project is not connected." });
    const outcome = await checkToken(row.token, row.gitlabProjectId, row.botUserId);
    await ctx.runMutation(internal.projectTokens.recordCheck, { tokenRowId: row.tokenRowId, ...outcome });
    return { problem: outcome.problem ?? null };
  },
});

// Replaces a project's pipeline and returns it with the new revision. Throws `pipeline_changed` when `expectedRevision` is stale
// and rejects a pipeline the catalog does not support.
export const savePipeline = mutation({
  args: { ...adminAuth, projectId: v.id("projects"), stageModels, expectedRevision: v.number() },
  handler: async (ctx, args) => {
    requireAdmin(args.adminSecret);
    const project = await ctx.db.get(args.projectId);
    if (!project) throw new ConvexError("project_not_found");
    const revision = project.pipelineRevision ?? 0;
    if (args.expectedRevision !== revision) throw new ConvexError("pipeline_changed");
    const pipeline = validatePipeline(args.stageModels, await ctx.db.query("modelCatalog").unique());
    await ctx.db.patch(project._id, { stageModels: pipeline, pipelineRevision: revision + 1 });
    return { stageModels: pipeline, revision: revision + 1 };
  },
});

// Forgets a project's token so its webhooks stop queueing reviews. Queued reviews fail at claim. Connect again to reverse it.
export const disconnectProject = mutation({
  args: { ...adminAuth, projectId: v.id("projects") },
  handler: async (ctx, args) => {
    requireAdmin(args.adminSecret);
    const row = await ctx.db.query("projectTokens").withIndex("by_project", (q) => q.eq("projectId", args.projectId)).unique();
    if (row) await ctx.db.delete(row._id);
  },
});
