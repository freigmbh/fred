import { actionableFindings, decisionPublication, inFlightStatuses } from "@fred/contracts";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { applyFindingDecision, decisionEligible, findingReference, findingsFor } from "./findingLifecycle";
import { gitlabWebUrl } from "./gitlabConfig";
import { finishedBy, grantLease, LEASE_MS, leaseLive, requireLease } from "./lease";
import { mrBusy } from "./mrWork";
import { scheduleMrNote } from "./mrNotes";
import { noteKeys } from "./noteKeys";
import { projectCredential, unconnectedProject } from "./projectTokens";
import { projectByGitlabId } from "./projects";
import { savedResult } from "./reviewOutcomes";
import { commandAction } from "./schema";
import { workerAuth, requireWorker } from "./workerAuth";

type Command = Doc<"findingCommands">;
const auth = { ...workerAuth, commandId: v.id("findingCommands"), leaseToken: v.string() };
const effectOrder = ["decision", "label"] as const;
// A command whose saved publication failed this many lease generations stays failed.
const MAX_FAILED_GENERATIONS = 5;
// How long a failed publication waits before another worker may claim it.
const PUBLICATION_RETRY_DELAY_MS = 30_000;
const unappliedDecision = "That decision was never applied; the review that advertised it did not complete.";

async function owned(ctx: QueryCtx, id: Command["_id"], leaseToken: string) {
  return requireLease(await ctx.db.get(id), leaseToken);
}

async function reply(ctx: MutationCtx, command: Pick<Command, "projectId" | "mrIid" | "provider">, key: string, body: string) {
  const project = await ctx.db.get(command.projectId);
  if (!project) throw new Error("finding command project missing");
  await scheduleMrNote(ctx, { key, gitlabProjectId: project.gitlabProjectId, projectPath: project.path, mrIid: command.mrIid, provider: command.provider, body });
}

// Posts the failure comment of one attempt, lease generation `generation`, of a command.
async function replyFailure(ctx: MutationCtx, command: Command, generation: number, message: string) {
  await reply(ctx, command, noteKeys.commandFailure(command.projectId, command.noteId, generation),
    `Finding command publication failed: ${message}. ${command.resultJson === undefined ? "No decision was applied." : "The decision is retained."}`);
}

async function findingByReference(ctx: QueryCtx, reference: string) {
  const id = ctx.db.normalizeId("findings", reference);
  if (id) return ctx.db.get(id);
  const [jobRef, indexRef, ...rest] = reference.split("/");
  const jobId = jobRef ? ctx.db.normalizeId("reviewJobs", jobRef) : null;
  if (!jobId || rest.length > 0 || !indexRef || !/^\d+$/.test(indexRef)) return null;
  const rows = await ctx.db.query("findings").withIndex("by_job", (q) => q.eq("jobId", jobId)).collect();
  return rows.find((row) => row.resultIndex === Number(indexRef)) ?? null;
}

function decisionByReference(ctx: QueryCtx, reference: string) {
  const id = ctx.db.normalizeId("findingDecisions", reference);
  return id ? ctx.db.get(id) : ctx.db.query("findingDecisions").withIndex("by_event", (q) => q.eq("eventKey", reference)).unique();
}

// A decision a review saved but has not applied yet, by the reference its summary advertised.
async function savedDecisionByReference(ctx: QueryCtx, reference: string) {
  const [jobRef, kind, findingRef, ...rest] = reference.split(":");
  const jobId = jobRef ? ctx.db.normalizeId("reviewJobs", jobRef) : null;
  const findingId = findingRef ? ctx.db.normalizeId("findings", findingRef) : null;
  if (!jobId || !findingId || kind !== "decision" || rest.length) return null;
  const job = await ctx.db.get(jobId);
  const decision = job && savedResult(job)?.findingDecisions.find((item) => item.findingId === findingId);
  return job && decision ? { findingId, after: decision.disposition, job } : null;
}

async function commandTarget(ctx: QueryCtx, action: Command["action"], reference: string) {
  if (action === "dismiss") {
    const finding = await findingByReference(ctx, reference);
    return { finding, expectedDecisionRef: finding?.decisionId ?? null };
  }
  const applied = await decisionByReference(ctx, reference);
  const saved = applied ? null : await savedDecisionByReference(ctx, reference);
  const decision = applied ?? saved;
  if (!decision) return { finding: null, expectedDecisionRef: null };
  return { finding: await ctx.db.get(decision.findingId), expectedDecisionRef: reference,
    rejection: decision.after !== "dismissed" && decision.after !== "retracted" ? "Only a dismissal or retraction can be undone."
      : saved && saved.job.status !== "queued" && saved.job.status !== "publishing" ? unappliedDecision : undefined };
}

// Admits a verified command note: queues the command, or replies with the rejection. Each note is admitted once.
export const enqueue = internalMutation({
  args: { gitlabProjectId: v.string(), mrIid: v.number(), noteId: v.string(), actorId: v.string(),
    action: commandAction, reference: v.string(), reason: v.string(), rejection: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const project = await projectByGitlabId(ctx, args.gitlabProjectId);
    if (!project) return { ignored: true };
    const deliveryKey = `finding-command:${project._id}:${args.noteId}`;
    if (await ctx.db.query("webhookDeliveries").withIndex("by_key", (q) => q.eq("key", deliveryKey)).unique()) return { duplicate: true };
    await ctx.db.insert("webhookDeliveries", { key: deliveryKey });
    const target = await commandTarget(ctx, args.action, args.reference);
    const finding = target.finding?.projectId === project._id && target.finding.mrIid === args.mrIid ? target.finding : null;
    const rejection = args.rejection
      ?? (!finding ? "Finding or decision does not belong to this merge request." : undefined)
      ?? (finding && finding.provider !== "fred" ? "That finding belongs to a retired reviewer account. FRED can only change its own findings." : undefined)
      ?? target.rejection;
    const scope = { projectId: project._id, mrIid: args.mrIid, noteId: args.noteId, provider: "fred" as const };
    if (!finding || rejection) {
      await reply(ctx, scope, noteKeys.commandRejection(project._id, args.noteId), `Finding command rejected: ${rejection}`);
      return { rejected: true };
    }
    const id = await ctx.db.insert("findingCommands", { ...scope, action: args.action, actorId: args.actorId, findingId: finding._id,
      expectedDecisionRef: target.expectedDecisionRef, reason: args.reason.trim(), status: "queued", publicationAcks: [] });
    return { commandId: id };
  },
});

// FRED's queued commands and those holding a lease, oldest first. Commands of the retired bots are never claimed.
export async function queuedCommands(ctx: QueryCtx) {
  return (await Promise.all(inFlightStatuses.map((status) =>
    ctx.db.query("findingCommands").withIndex("by_status_provider", (q) => q.eq("status", status).eq("provider", "fred")).collect()))).flat()
    .sort((a, b) => a._creationTime - b._creationTime);
}

// Leases the oldest claimable command to `workerId` with its project's credential, or returns null. A command whose project
// has no usable token fails instead.
export async function claimCommand(ctx: MutationCtx, workerId: string) {
  const now = Date.now();
  for (const command of await queuedCommands(ctx)) {
    if (leaseLive(command, now)) continue;
    if (await mrBusy(ctx, command.projectId, command.mrIid, command._id)) continue;
    if (command.action === "undo" && command.expectedDecisionRef && !command.resultJson
      && !(await decisionByReference(ctx, command.expectedDecisionRef))) {
      const saved = await savedDecisionByReference(ctx, command.expectedDecisionRef);
      if (saved?.job.status === "queued" && saved.job.projectId === command.projectId
        && saved.job.mrIid === command.mrIid && saved.job.provider === command.provider) continue;
    }
    const project = await ctx.db.get(command.projectId);
    if (!project) throw new Error("finding command project missing");
    const credential = await projectCredential(ctx, project);
    if (!credential) {
      await ctx.db.patch(command._id, { status: "failed", failure: unconnectedProject });
      await replyFailure(ctx, command, (command.leaseGeneration ?? 0) + 1, unconnectedProject);
      continue;
    }
    const lease = { ...grantLease(command, workerId, now), status: command.resultJson ? "publishing" as const : "running" as const };
    await ctx.db.patch(command._id, lease);
    return { ...command, ...lease, kind: "finding_command" as const, gitlabProjectId: project.gitlabProjectId,
      gitlabBotUserId: credential.botUserId, gitlabBotUserIds: credential.botUserIds, gitlabToken: credential.token };
  }
  return null;
}

export const heartbeat = mutation({ args: auth, handler: async (ctx, args) => {
  requireWorker(args.workerSecret);
  await owned(ctx, args.commandId, args.leaseToken);
  const leaseExpiresAt = Date.now() + LEASE_MS;
  await ctx.db.patch(args.commandId, { leaseExpiresAt });
  return { leaseExpiresAt };
} });

export const context = query({ args: auth, handler: async (ctx, args) => {
  requireWorker(args.workerSecret);
  return findingsFor(ctx, await owned(ctx, args.commandId, args.leaseToken));
} });

export const reconcileSummary = mutation({ args: { ...auth, jobId: v.id("reviewJobs"), noteId: v.string() }, handler: async (ctx, args) => {
  requireWorker(args.workerSecret);
  const command = await owned(ctx, args.commandId, args.leaseToken);
  const job = await ctx.db.get(args.jobId);
  if (!job || job.projectId !== command.projectId || job.mrIid !== command.mrIid || job.provider !== command.provider) throw new Error("foreign review publication");
  await ctx.db.patch(job._id, { summaryNoteId: args.noteId });
  for (const finding of await ctx.db.query("findings").withIndex("by_job", (q) => q.eq("jobId", job._id)).collect()) {
    if (finding.status === "pending") await ctx.db.patch(finding._id, { status: "posted" });
  }
} });

async function decisionPublicationFor(ctx: QueryCtx, command: Command, finding: Doc<"findings">, after: "dismissed" | "open", eventKey: string) {
  const remaining = actionableFindings(await findingsFor(ctx, command));
  const project = await ctx.db.get(command.projectId);
  if (!project) throw new Error("finding project missing");
  const mrUrl = `${gitlabWebUrl() ?? ""}/${project.path}/-/merge_requests/${command.mrIid}`;
  const links = remaining.map((item) => {
    const noteId = item.noteId ?? item.summaryNoteId;
    return `[${item.reference}](${mrUrl}${noteId ? `#note_${noteId}` : ""})`;
  });
  const reason = command.reason.replace(/[\\`*_{}\[\]<>()!|]/g, "\\$&");
  const undo = after === "dismissed" ? ` Undo with \`fred undo ${eventKey} <reason>\`.` : "";
  const body = [
    `Finding ${findingReference(finding)} ${after === "open" ? "reopened" : "dismissed"} by GitLab user ${command.actorId}.`,
    `Reason: ${reason}`,
    `Decision: \`${eventKey}\`.${undo}`,
    `${remaining.length} actionable findings remain.${links.length ? ` ${links.join(", ")}` : ""}`,
  ].join("\n\n");
  return decisionPublication.parse({ body, ...(finding.discussionId ? { discussionId: finding.discussionId } : {}),
    resolved: after !== "open", label: remaining.length ? "findings" : "clean" });
}

export const prepare = mutation({ args: auth, handler: async (ctx, args) => {
  requireWorker(args.workerSecret);
  const command = await owned(ctx, args.commandId, args.leaseToken);
  if (command.resultJson) return command.resultJson;
  const finding = await ctx.db.get(command.findingId);
  if (!finding) throw new Error("finding missing");
  const after = command.action === "dismiss" ? "dismissed" : "open";
  const expectedDecisionId = command.expectedDecisionRef === null ? null : (await decisionByReference(ctx, command.expectedDecisionRef))?._id;
  if (expectedDecisionId === undefined || !decisionEligible(finding, expectedDecisionId, after)) {
    await reply(ctx, command, noteKeys.commandRejection(command.projectId, command.noteId), `Finding command rejected: ${expectedDecisionId === undefined ? unappliedDecision
      : "The finding changed or is not eligible. Use its current finding or decision reference."}`);
    await ctx.db.patch(command._id, { status: "done" });
    return null;
  }
  const eventKey = `command:${command._id}`;
  await applyFindingDecision(ctx, finding, { eventKey, expectedDecisionId, after,
    reason: command.reason, actorId: command.actorId, source: "human", commandId: command._id, noteId: command.noteId });
  const resultJson = JSON.stringify(await decisionPublicationFor(ctx, command, finding, after, eventKey));
  await ctx.db.patch(command._id, { resultJson, status: "publishing" });
  return resultJson;
} });

export const acknowledge = mutation({ args: { ...auth, effect: v.union(v.literal("decision"), v.literal("label")) }, handler: async (ctx, args) => {
  requireWorker(args.workerSecret);
  const completed = await ctx.db.get(args.commandId);
  if (finishedBy(completed, args.leaseToken, "done") && completed?.publicationAcks.includes(args.effect)) return;
  const command = await owned(ctx, args.commandId, args.leaseToken);
  if (!command.resultJson) throw new Error("finding command has no publication");
  if (command.publicationAcks.includes(args.effect)) return;
  if (effectOrder[command.publicationAcks.length] !== args.effect) throw new Error("finding command acknowledgement out of order");
  await ctx.db.patch(command._id, { publicationAcks: [...command.publicationAcks, args.effect], ...(args.effect === "label" ? { status: "done" as const } : {}) });
} });

// Records a failed lease generation and posts its comment. Saved publication retries under a new lease, up to
// MAX_FAILED_GENERATIONS; a command without one fails for good.
export const fail = mutation({ args: { ...auth, message: v.string() }, handler: async (ctx, args) => {
  requireWorker(args.workerSecret);
  const command = await owned(ctx, args.commandId, args.leaseToken);
  const generation = command.leaseGeneration ?? 0;
  await replyFailure(ctx, command, generation, args.message);
  const retryable = command.resultJson !== undefined && generation < MAX_FAILED_GENERATIONS;
  await ctx.db.patch(command._id, { status: retryable ? "publishing" : "failed", leaseExpiresAt: Date.now() + PUBLICATION_RETRY_DELAY_MS, failure: args.message });
} });
