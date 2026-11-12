import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalMutation, internalQuery, mutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import { adminAuth, requireAdmin } from "./adminAuth";
import { requireLease } from "./lease";
import { transcriptFields } from "./schema";
import { requireWorker, workerAuth } from "./workerAuth";

const leaseArgs = { jobId: v.id("reviewJobs"), leaseToken: v.string() };

// Rejects a stale owner with lease_lost, then a job queued without collection.
async function collectingJob(ctx: QueryCtx, jobId: Id<"reviewJobs">, leaseToken: string) {
  const job = requireLease(await ctx.db.get(jobId), leaseToken);
  if (job.collectTranscripts !== true) throw new ConvexError("transcript_collection_off");
  return job;
}

// Appends the audit row for a switch or deletion. `actor` is "dashboard" for the Convex dashboard, "admin" for the admin UI.
async function audit(ctx: MutationCtx, actor: "dashboard" | "admin", table: string, rowId: string, before: unknown, after: unknown) {
  await ctx.db.insert("policyAudit", { actor, table, rowId, before: JSON.stringify(before), after: JSON.stringify(after), at: Date.now() });
}

// Sets one project's switch and audits it. Applies to jobs queued afterwards; queued jobs keep their snapshot.
async function switchCollection(ctx: MutationCtx, project: Doc<"projects">, enabled: boolean, actor: "dashboard" | "admin") {
  await ctx.db.patch(project._id, { collectTranscripts: enabled });
  await audit(ctx, actor, "projects", project._id, { collectTranscripts: project.collectTranscripts ?? false }, { collectTranscripts: enabled });
}

// Deletes every transcript file and row of one job and returns how many rows went.
async function deleteTranscripts(ctx: MutationCtx, jobId: Id<"reviewJobs">) {
  const rows = await ctx.db.query("transcripts").withIndex("by_job", (q) => q.eq("jobId", jobId)).collect();
  for (const row of rows) {
    if (row.storageId) await ctx.storage.delete(row.storageId);
    await ctx.db.delete(row._id);
  }
  return rows.length;
}

// Lets store refuse before it writes a blob.
export const checkStore = internalQuery({
  args: leaseArgs,
  handler: async (ctx, args) => { await collectingJob(ctx, args.jobId, args.leaseToken); },
});

// Inserts the row under the job's current lease generation. Returns false when the attempt already has one, which is kept.
export const record = internalMutation({
  args: { ...leaseArgs, ...transcriptFields, storageId: v.optional(v.id("_storage")), bytes: v.number() },
  handler: async (ctx, { leaseToken, ...row }) => {
    const job = await collectingJob(ctx, row.jobId, leaseToken);
    const leaseGeneration = job.leaseGeneration ?? 0;
    const existing = await ctx.db.query("transcripts").withIndex("by_job", (q) =>
      q.eq("jobId", job._id).eq("leaseGeneration", leaseGeneration).eq("stage", row.stage)).first();
    if (existing) return false;
    await ctx.db.insert("transcripts", { ...row, leaseGeneration, recordedAt: Date.now() });
    return true;
  },
});

// Called by the worker once per stage exit of a collecting job, with the gzipped file or an omission. A retry of the same
// attempt keeps the first row. The stored blob never outlives a rejected or duplicate record.
export const store = action({
  args: { ...workerAuth, ...leaseArgs, ...transcriptFields, file: v.optional(v.bytes()) },
  handler: async (ctx, { workerSecret, file, ...args }): Promise<null> => {
    requireWorker(workerSecret);
    if ((file === undefined) === (args.omitted === undefined)) throw new ConvexError("transcript_file_or_omission_required");
    await ctx.runQuery(internal.transcripts.checkStore, { jobId: args.jobId, leaseToken: args.leaseToken });
    const storageId = file && await ctx.storage.store(new Blob([file], { type: "application/gzip" }));
    try {
      const recorded = await ctx.runMutation(internal.transcripts.record, { ...args, ...(storageId ? { storageId } : {}), bytes: file?.byteLength ?? 0 });
      if (!recorded && storageId) await ctx.storage.delete(storageId);
    } catch (error) {
      if (storageId) await ctx.storage.delete(storageId);
      throw error;
    }
    return null;
  },
});

// The row behind a download, read inside the action.
export const readTranscript = internalQuery({
  args: { transcriptId: v.id("transcripts") },
  handler: (ctx, args) => ctx.db.get(args.transcriptId),
});

// Serves one transcript file to the admin UI as bytes, re-exported as admin.downloadTranscript. Storage URLs need no
// credential, so they are never handed out.
export const downloadTranscript = action({
  args: { ...adminAuth, transcriptId: v.id("transcripts") },
  handler: async (ctx, args): Promise<{ fileName: string; bytes: ArrayBuffer }> => {
    requireAdmin(args.adminSecret);
    const transcript = await ctx.runQuery(internal.transcripts.readTranscript, { transcriptId: args.transcriptId });
    const blob = transcript?.storageId && await ctx.storage.get(transcript.storageId);
    if (!transcript || !blob) throw new ConvexError("transcript_unavailable");
    return { fileName: `fred-${transcript.jobId}-${transcript.stage}-g${transcript.leaseGeneration}.json.gz`, bytes: await blob.arrayBuffer() };
  },
});

// Run from the Convex dashboard or `convex run`.
export const setCollection = internalMutation({
  args: { projectPath: v.string(), enabled: v.boolean() },
  handler: async (ctx, args) => {
    const project = await ctx.db.query("projects").withIndex("by_path", (q) => q.eq("path", args.projectPath)).unique();
    if (!project) throw new ConvexError("project_not_found");
    await switchCollection(ctx, project, args.enabled, "dashboard");
  },
});

// The Projects page's switch, re-exported as admin.setTranscriptCollection.
export const setTranscriptCollection = mutation({
  args: { ...adminAuth, projectId: v.id("projects"), enabled: v.boolean() },
  handler: async (ctx, args) => {
    requireAdmin(args.adminSecret);
    const project = await ctx.db.get(args.projectId);
    if (!project) throw new ConvexError("project_not_found");
    await switchCollection(ctx, project, args.enabled, "admin");
  },
});

// Run from the Convex dashboard or `convex run`. Findings, usage, and decisions stay.
export const deleteForJob = internalMutation({
  args: { jobId: v.id("reviewJobs") },
  handler: async (ctx, args) => {
    const deleted = await deleteTranscripts(ctx, args.jobId);
    await audit(ctx, "dashboard", "transcripts", args.jobId, { transcripts: deleted }, { transcripts: 0 });
    return { deleted };
  },
});

// Run from the Convex dashboard or `convex run`. Deletes the transcripts of every job of one MR.
export const deleteForMr = internalMutation({
  args: { projectPath: v.string(), mrIid: v.number() },
  handler: async (ctx, args) => {
    const project = await ctx.db.query("projects").withIndex("by_path", (q) => q.eq("path", args.projectPath)).unique();
    if (!project) throw new ConvexError("project_not_found");
    const jobs = await ctx.db.query("reviewJobs").withIndex("by_mr", (q) => q.eq("projectId", project._id).eq("mrIid", args.mrIid)).collect();
    let deleted = 0;
    for (const job of jobs) deleted += await deleteTranscripts(ctx, job._id);
    await audit(ctx, "dashboard", "transcripts", `${project._id}:${args.mrIid}`, { transcripts: deleted }, { transcripts: 0 });
    return { deleted };
  },
});
