import { inFlightStatuses, triggerKind } from "@fred/contracts";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { capture, captureJob } from "./diagnosticCapture";
import { denyReview } from "./jobLifecycle";
import { checkPolicy } from "./policyInput";
import { connection } from "./projectTokens";
import { upsertProject } from "./projects";
import { provider } from "./schema";
import { literals } from "./validators";

async function upsertDeveloper(ctx: MutationCtx, owner: { gitlabUserId: string; username?: string | undefined; displayName?: string | undefined }) {
  const existing = await ctx.db
    .query("developers")
    .withIndex("by_gitlab_user", (q) => q.eq("gitlabUserId", owner.gitlabUserId))
    .unique();
  const profile = {
    ...(owner.username ? { username: owner.username } : {}),
    ...(owner.displayName !== undefined ? { displayName: owner.displayName.trim() || undefined } : {}),
  };
  if (existing) {
    await ctx.db.patch(existing._id, profile);
    return (await ctx.db.get(existing._id))!;
  }
  const id = await ctx.db.insert("developers", {
    gitlabUserId: owner.gitlabUserId,
    ...(owner.username ? { username: owner.username } : {}),
    ...(profile.displayName ? { displayName: profile.displayName } : {}),
  });
  return (await ctx.db.get(id))!;
}

async function supersedeQueued(ctx: MutationCtx, projectId: Id<"projects">, mrIid: number, p: Doc<"reviewJobs">["provider"]) {
  const queued = await ctx.db
    .query("reviewJobs")
    .withIndex("by_mr", (q) => q.eq("projectId", projectId).eq("mrIid", mrIid))
    .filter((q) => q.and(q.eq(q.field("status"), "queued"), q.eq(q.field("provider"), p)))
    .collect();
  for (const job of queued) {
    await ctx.db.patch(job._id, { status: "superseded" });
    await captureJob(ctx, job, { kind: "superseded", phase: "queue", at: Date.now(), reason: "new_head" });
  }
}

// Turns one webhook trigger into a queued review, a recovered publication, a denial, or nothing. `deliveryKey` identifies the
// webhook delivery, so a replay does nothing.
export const enqueue = internalMutation({
  args: {
    provider,
    kind: literals(triggerKind.options),
    deliveryKey: v.string(),
    headSha: v.string(),
    mrIid: v.number(),
    project: v.object({ gitlabProjectId: v.string(), path: v.string() }),
    triggeredBy: v.string(),
    budgetOwner: v.object({ gitlabUserId: v.string(), username: v.optional(v.string()), displayName: v.optional(v.string()) }),
  },
  handler: async (ctx, args) => {
    const project = await upsertProject(ctx, args.project);
    const context = { gitlabProjectId: args.project.gitlabProjectId, projectPath: args.project.path, mrIid: args.mrIid, provider: args.provider };
    const pipeline = project.stageModels;
    if (!pipeline || !(await connection(ctx, project))) {
      await capture(ctx, context, { kind: "webhook_ignored", phase: "webhook", at: Date.now(), reason: "unconfigured" });
      return { result: "ignored" as const };
    }
    const developer = await upsertDeveloper(ctx, args.budgetOwner);

    const deliveryKey = JSON.stringify([args.project.gitlabProjectId, args.provider, args.deliveryKey]);
    if (await ctx.db.query("webhookDeliveries").withIndex("by_key", (q) => q.eq("key", deliveryKey)).unique()) {
      await capture(ctx, context, { kind: "duplicate", phase: "queue", at: Date.now(), reason: "duplicate_delivery" });
      return { result: "duplicate" as const };
    }
    await ctx.db.insert("webhookDeliveries", { key: deliveryKey });

    const latest = await ctx.db.query("reviewJobs").withIndex("by_dedupe", (q) =>
      q.eq("projectId", project._id).eq("mrIid", args.mrIid).eq("headSha", args.headSha).eq("provider", args.provider),
    ).order("desc").first();
    const active = await Promise.all(inFlightStatuses.map((status) =>
      ctx.db.query("reviewJobs").withIndex("by_dedupe_status", (q) =>
        q.eq("projectId", project._id).eq("mrIid", args.mrIid).eq("headSha", args.headSha).eq("provider", args.provider).eq("status", status),
      ).first()));
    const outstanding = active.find((job) => job !== null);
    const deliberate = args.kind === "re_requested" || args.kind === "reviewer_added";
    const retry = deliberate && (latest?.status === "failed" || latest?.status === "denied");
    if (outstanding || (latest && !retry && args.kind !== "re_requested")) {
      await capture(ctx, { ...context, jobId: outstanding?._id ?? latest?._id }, { kind: "duplicate", phase: "queue", at: Date.now(), reason: "duplicate_review" });
      return { result: "duplicate" as const };
    }

    if (args.kind === "push") await supersedeQueued(ctx, project._id, args.mrIid, args.provider);

    const recovery = latest?.status === "failed" && retry && latest.resultJson !== undefined ? latest : undefined;
    const policyOwner = recovery ? await ctx.db.get(recovery.developerId) : developer;
    if (!policyOwner) throw new Error("job references missing developer");
    const policy = await checkPolicy(ctx, { developer: policyOwner, projectId: project._id, provider: args.provider, now: Date.now() });
    if (!policy.allowed) {
      await denyReview(ctx, { project, mrIid: args.mrIid, headSha: args.headSha, provider: args.provider, developerId: policyOwner._id,
        triggeredBy: args.triggeredBy }, policy, Date.now());
      return { result: "denied" as const, reason: policy.reason };
    }

    if (recovery) {
      await ctx.db.patch(recovery._id, { status: "queued", leaseGeneration: (recovery.leaseGeneration ?? 0) + 1,
        leaseToken: undefined, leaseExpiresAt: undefined, workerId: undefined, completedAt: undefined,
        failureReason: undefined, denialReason: undefined, diagnosticJson: undefined });
      const recovered = await ctx.db.get(recovery._id);
      if (recovered) await captureJob(ctx, recovered, { kind: "queued", phase: "queue", at: Date.now(), outcome: "recovered" });
      return { result: "queued" as const, jobId: recovery._id };
    }

    const jobId = await ctx.db.insert("reviewJobs", {
      projectId: project._id,
      mrIid: args.mrIid,
      headSha: args.headSha,
      provider: args.provider,
      stageModels: pipeline,
      ...(project.collectTranscripts ? { collectTranscripts: true } : {}),
      status: "queued",
      developerId: developer._id,
      triggeredBy: args.triggeredBy,
      deliveryKey: args.deliveryKey,
    });
    await capture(ctx, { ...context, jobId }, { kind: "queued", phase: "queue", at: Date.now() },
      { phase: "queue", at: Date.now(), leaseGeneration: 0, droppedEvents: 0 });
    return { result: "queued" as const, jobId };
  },
});
