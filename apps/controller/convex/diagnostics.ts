import { diagnosticEvent, diagnosticSnapshot, storedDiagnosticEvent } from "@fred/contracts";
import { v } from "convex/values";
import { z } from "zod";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, internalQuery, mutation, type QueryCtx } from "./_generated/server";
import { capture, diagnosticRetentionMs, jobContext, jobSnapshot, mergeSnapshot, readSnapshot } from "./diagnosticCapture";
import { leaseLost, requireLease } from "./lease";
import { noteKeys } from "./noteKeys";
import { savedResult } from "./reviewOutcomes";
import { provider } from "./schema";
import { requireWorker, workerAuth } from "./workerAuth";

const rowLimit = 20;
const eventLimit = 1000;
const usageLimit = 200;
const payloadLimit = 131_072;
const selectionMetadata = z.object({ model: diagnosticEvent.shape.model.unwrap(), effort: diagnosticEvent.shape.effort.unwrap() });
const stageModelMetadata = z.object({ detect: selectionMetadata, validate: selectionMetadata });

export const record = mutation({
  args: { ...workerAuth, jobId: v.id("reviewJobs"), leaseToken: v.string(), eventsJson: v.string(), snapshotJson: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireWorker(args.workerSecret);
    if (args.eventsJson.length + (args.snapshotJson?.length ?? 0) > payloadLimit) throw new Error("diagnostic payload too large");
    const events = z.array(diagnosticEvent).max(25).parse(JSON.parse(args.eventsJson));
    const snapshot = args.snapshotJson === undefined ? undefined : diagnosticSnapshot.parse(JSON.parse(args.snapshotJson));
    const job = requireLease(await ctx.db.get(args.jobId), args.leaseToken, { finished: true });
    if (job.failureReason === "stale") throw leaseLost();
    if (snapshot && snapshot.leaseGeneration !== job.leaseGeneration) throw new Error("diagnostic lease generation mismatch");
    const context = await jobContext(ctx, job);
    for (const event of events) await capture(ctx, context, event);
    if (snapshot) {
      const row = await ctx.db.query("diagnosticSnapshots").withIndex("by_job", (q) => q.eq("jobId", job._id)).unique();
      const snapshotJson = JSON.stringify(mergeSnapshot(readSnapshot(row?.snapshotJson), snapshot));
      if (row) await ctx.db.patch(row._id, { snapshotJson });
      else await ctx.db.insert("diagnosticSnapshots", { jobId: job._id, snapshotJson });
    }
    return null;
  },
});

export const webhook = internalMutation({
  args: { eventJson: v.string(), projectPath: v.optional(v.string()), gitlabProjectId: v.optional(v.string()), mrIid: v.optional(v.number()) },
  handler: async (ctx, { eventJson, ...context }) => {
    await capture(ctx, context, diagnosticEvent.parse(JSON.parse(eventJson)));
  },
});

export const prune = internalMutation({
  args: {},
  handler: async (ctx) => {
    const expired = await ctx.db.query("diagnosticEvents").withIndex("by_expiry", (q) => q.lte("expiresAt", Date.now())).take(500);
    for (const row of expired) await ctx.db.delete(row._id);
    return expired.length;
  },
});

// The saved result's effect count, null without a result. An unreadable result is flagged instead of thrown, so the rest of
// the report stays visible.
function savedEffectCount(job: Doc<"reviewJobs">) {
  try {
    return { total: savedResult(job)?.effects.length ?? null, resultUnreadable: false };
  } catch {
    return { total: null, resultUnreadable: true };
  }
}

async function jobReport(ctx: QueryCtx, job: Doc<"reviewJobs">) {
  const project = await ctx.db.get(job.projectId);
  const snapshot = await jobSnapshot(ctx, job);
  const stageModels = stageModelMetadata.safeParse(job.stageModels);
  const usage = await ctx.db.query("usageEvents").withIndex("by_job", (q) => q.eq("jobId", job._id)).take(usageLimit + 1);
  const totals = usage.slice(0, usageLimit).reduce((sum, row) => ({
    inputTokens: sum.inputTokens + row.inputTokens, cachedInputTokens: sum.cachedInputTokens + row.cachedInputTokens,
    outputTokens: sum.outputTokens + row.outputTokens, costUsd: sum.costUsd + row.costUsd,
  }), { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: 0 });
  return {
    jobId: job._id, gitlabProjectId: project?.gitlabProjectId ?? null, projectPath: project?.path ?? null,
    mrIid: job.mrIid, headSha: job.headSha, previousReviewedSha: job.previousReviewedSha ?? null, provider: job.provider, status: job.status,
    triggeredBy: job.triggeredBy, failureReason: job.failureReason ?? null, failureText: job.denialReason ?? null,
    stageModels: stageModels.success ? stageModels.data : null,
    createdAt: job._creationTime, claimedAt: job.claimedAt ?? null, completedAt: job.completedAt ?? null,
    workerId: job.workerId ?? null, leaseGeneration: job.leaseGeneration ?? 0, leaseExpiresAt: job.leaseExpiresAt ?? null,
    snapshot: snapshot ? { ...snapshot, ...(job.status === "done" ? { phase: "complete" as const } : {}) } : null,
    publication: { acknowledged: job.publicationAcks?.length ?? 0, ...savedEffectCount(job), acks: job.publicationAcks ?? [] },
    usage: { ...totals, rows: Math.min(usage.length, usageLimit), truncated: usage.length > usageLimit,
      incomplete: job.usageIncomplete ?? false, incompleteReason: job.usageIncompleteReason ?? null,
      confirmedStages: job.usageConfirmedStages ?? [], correctionsIncluded: usage.some((row) => row.supersedes !== undefined) },
    failures: await ctx.db.query("reviewFailures").withIndex("by_job", (q) => q.eq("jobId", job._id)).take(rowLimit),
  };
}

type EventSelector = { [Key in "jobId" | "gitlabProjectId" | "projectPath" | "mrIid"]?: Doc<"diagnosticEvents">[Key] | undefined };

function eventsFor(ctx: QueryCtx, { jobId, gitlabProjectId, projectPath, mrIid }: EventSelector) {
  const table = ctx.db.query("diagnosticEvents");
  if (jobId !== undefined) return table.withIndex("by_job", (q) => q.eq("jobId", jobId));
  if (gitlabProjectId !== undefined) {
    return mrIid === undefined
      ? table.withIndex("by_project", (q) => q.eq("gitlabProjectId", gitlabProjectId))
      : table.withIndex("by_mr", (q) => q.eq("gitlabProjectId", gitlabProjectId).eq("mrIid", mrIid));
  }
  if (projectPath !== undefined) {
    return table.withIndex("by_path_mr", (q) => mrIid === undefined ? q.eq("projectPath", projectPath) : q.eq("projectPath", projectPath).eq("mrIid", mrIid));
  }
  return table.withIndex("by_recorded");
}

export const inspect = internalQuery({
  args: { jobId: v.optional(v.id("reviewJobs")), gitlabProjectId: v.optional(v.string()), projectPath: v.optional(v.string()), mrIid: v.optional(v.number()), provider: v.optional(provider) },
  handler: async (ctx, args) => {
    const { jobId, gitlabProjectId: requestedProjectId, projectPath, mrIid, provider: requestedProvider } = args;
    const byProject = requestedProjectId !== undefined || projectPath !== undefined;
    if (jobId !== undefined && (byProject || mrIid !== undefined)) throw new Error("jobId cannot be combined with a project selector");
    if (requestedProjectId !== undefined && projectPath !== undefined) throw new Error("choose project ID or path");
    if (mrIid !== undefined && !byProject) throw new Error("mrIid requires gitlabProjectId");
    const now = Date.now();
    const project = requestedProjectId !== undefined
      ? await ctx.db.query("projects").withIndex("by_gitlab_project", (q) => q.eq("gitlabProjectId", requestedProjectId)).unique()
      : projectPath !== undefined
        ? await ctx.db.query("projects").withIndex("by_path", (q) => q.eq("path", projectPath)).first()
        : null;
    const gitlabProjectId = requestedProjectId ?? project?.gitlabProjectId;

    let candidates: Doc<"reviewJobs">[] = [];
    if (jobId !== undefined) {
      const job = await ctx.db.get(jobId);
      if (job) candidates = [job];
    } else if (project) {
      const scope = mrIid === undefined
        ? ctx.db.query("reviewJobs").withIndex("by_project", (q) => q.eq("projectId", project._id))
        : ctx.db.query("reviewJobs").withIndex("by_mr", (q) => q.eq("projectId", project._id).eq("mrIid", mrIid));
      candidates = await scope.order("desc").take(rowLimit + 1);
    } else if (!byProject) {
      candidates = await ctx.db.query("reviewJobs").order("desc").take(rowLimit + 1);
    }
    const jobs = candidates.slice(0, rowLimit).filter((job) => requestedProvider === undefined || job.provider === requestedProvider);

    const eventRows = await eventsFor(ctx, { jobId, gitlabProjectId, projectPath, mrIid }).order("desc").take(eventLimit + 1);
    const selectedJob = jobId !== undefined ? jobs[0] : undefined;
    const selectedProject = selectedJob ? await ctx.db.get(selectedJob.projectId) : null;
    const receiptRows = selectedJob && selectedProject
      ? await eventsFor(ctx, { gitlabProjectId: selectedProject.gitlabProjectId, mrIid: selectedJob.mrIid }).order("desc").take(eventLimit + 1)
      : [];
    const combinedEvents = [...eventRows, ...receiptRows.filter((row) => row.jobId === undefined)]
      .sort((a, b) => b.recordedAt - a.recordedAt || b._creationTime - a._creationTime);
    const selectedProvider = requestedProvider ?? selectedJob?.provider;
    let invalidEvents = 0;
    const events = combinedEvents.slice(0, eventLimit).flatMap((row) => {
      if (row.expiresAt <= now || (selectedProvider && row.provider !== undefined && row.provider !== selectedProvider)) return [];
      try {
        const event = storedDiagnosticEvent.parse(JSON.parse(row.eventJson));
        return [{ eventId: row._id, jobId: row.jobId ?? null, gitlabProjectId: row.gitlabProjectId ?? null, mrIid: row.mrIid ?? null,
          provider: row.provider ?? null, leaseGeneration: row.leaseGeneration ?? null, recordedAt: row.recordedAt, event }];
      } catch { invalidEvents += 1; return []; }
    });

    const noteRows = jobId !== undefined
      ? [...await ctx.db.query("mrNotes").withIndex("by_job", (q) => q.eq("jobId", jobId)).order("desc").take(rowLimit + 1),
         ...await ctx.db.query("mrNotes").withIndex("by_key", (q) => q.eq("key", noteKeys.jobDenial(jobId))).take(1)].filter((row, index, rows) => rows.findIndex((other) => other._id === row._id) === index)
      : gitlabProjectId !== undefined
        ? await ctx.db.query("mrNotes").withIndex("by_mr", (q) => mrIid === undefined ? q.eq("gitlabProjectId", gitlabProjectId) : q.eq("gitlabProjectId", gitlabProjectId).eq("mrIid", mrIid)).order("desc").take(rowLimit + 1)
        : byProject ? [] : await ctx.db.query("mrNotes").order("desc").take(rowLimit + 1);
    const notes = noteRows.slice(0, rowLimit).filter((row) => requestedProvider === undefined || row.provider === requestedProvider).map((row) => ({
      noteId: row._id, key: row.key, jobId: row.jobId ?? null, gitlabProjectId: row.gitlabProjectId, mrIid: row.mrIid, provider: row.provider,
      status: row.status, attempts: row.attempts, lastError: row.lastError ?? null, createdAt: row._creationTime, body: row.body,
      failure: readSnapshot(row.failureJson)?.failure ?? null,
    }));

    return { jobs: await Promise.all(jobs.map((job) => jobReport(ctx, job))), events, notes,
      coverage: { recordedAt: now, retentionDays: 7, retentionCutoff: now - diagnosticRetentionMs,
        jobsTruncated: candidates.length > rowLimit, eventsTruncated: combinedEvents.length > eventLimit || receiptRows.length > eventLimit, notesTruncated: noteRows.length > rowLimit,
        invalidEvents, empty: jobs.length === 0 && events.length === 0 && notes.length === 0,
        noWebhookReceipt: !events.some(({ event }) => event.kind === "webhook_received"),
        bestEffort: true, missingEvidenceDoesNotProveNoRequest: true } };
  },
});
