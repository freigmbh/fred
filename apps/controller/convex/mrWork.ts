import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

// True while FRED work other than `except` holds the MR: publishing, or running under a live lease. Work of the retired
// Claude and Codex bots never counts.
export async function mrBusy(ctx: QueryCtx, projectId: Id<"projects">, mrIid: number, except?: Id<"reviewJobs"> | Id<"findingCommands">) {
  const [reviews, commands] = await Promise.all([
    ctx.db.query("reviewJobs").withIndex("by_mr", (q) => q.eq("projectId", projectId).eq("mrIid", mrIid)).collect(),
    ctx.db.query("findingCommands").withIndex("by_mr", (q) => q.eq("projectId", projectId).eq("mrIid", mrIid)).collect(),
  ]);
  const now = Date.now();
  return [...reviews, ...commands].some((work) => work._id !== except && work.provider === "fred" &&
    (work.status === "publishing" || (work.status === "running" && (work.leaseExpiresAt ?? Infinity) > now)));
}
