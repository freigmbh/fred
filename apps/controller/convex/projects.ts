import type { MutationCtx, QueryCtx } from "./_generated/server";
import { otherBotIds } from "./gitlabConfig";

export function projectByGitlabId(ctx: QueryCtx, gitlabProjectId: string) {
  return ctx.db.query("projects").withIndex("by_gitlab_project", (q) => q.eq("gitlabProjectId", gitlabProjectId)).unique();
}

// Finds the project by its GitLab ID, creating it on first sight and following a renamed path.
export async function upsertProject(ctx: MutationCtx, project: { gitlabProjectId: string; path: string }) {
  const existing = await projectByGitlabId(ctx, project.gitlabProjectId);
  if (existing) {
    if (existing.path !== project.path) await ctx.db.patch(existing._id, { path: project.path });
    return { ...existing, path: project.path };
  }
  const id = await ctx.db.insert("projects", project);
  return (await ctx.db.get(id))!;
}

// Every project's current and former FRED bot users and BOT_USER_IDS_OTHER. Their MRs trigger reviews only through a
// human, and their finding commands are ignored.
export async function botUserIds(ctx: QueryCtx) {
  const fred = (await ctx.db.query("projects").collect()).flatMap((project) => project.botUserIds ?? []);
  return [...fred, ...otherBotIds()];
}
