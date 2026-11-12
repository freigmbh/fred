import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type ActionCtx, type MutationCtx } from "./_generated/server";
import { gitlabRetryDelaysMs } from "./gitlabRest";
import { authorizeFindingCommand } from "./gitlabVerification";
import { noteKeys } from "./noteKeys";
import { scheduleMrNote } from "./mrNotes";
import { projectCredential } from "./projectTokens";
import { botUserIds, projectByGitlabId } from "./projects";
import { findingCommandRequestInput } from "./schema";

type Receipt = Doc<"findingCommandRequests">;
const requestArgs = { requestId: v.id("findingCommandRequests") };
const attemptArgs = { ...requestArgs, attempt: v.number() };
const RETRY_DELAYS_MS = gitlabRetryDelaysMs.slice(0, 3);
const ATTEMPT_TIMEOUT_MS = 45_000;
const failureMessages = {
  configuration: "GitLab configuration is unavailable or invalid.",
  gitlab: "GitLab refused the verification request.",
  exhausted: "GitLab verification failed after four attempts.",
};

export const receive = internalMutation({
  args: { gitlabProjectId: v.string(), noteId: v.string(), command: findingCommandRequestInput },
  handler: async (ctx, args) => {
    const project = await projectByGitlabId(ctx, args.gitlabProjectId);
    if (!project) return { ignored: true };
    const existing = await ctx.db.query("findingCommandRequests").withIndex("by_note", (q) => q.eq("projectId", project._id).eq("noteId", args.noteId)).unique();
    if (!existing) {
      const requestId = await ctx.db.insert("findingCommandRequests", {
        projectId: project._id, noteId: args.noteId, command: args.command, status: "pending", attempts: 0, nextAttemptAt: Date.now(),
      });
      await ctx.scheduler.runAfter(0, internal.findingCommandRequests.dispatch, { requestId });
    }
    return { received: true };
  },
});

async function failReceipt(ctx: MutationCtx, receipt: Receipt, failure: keyof typeof failureMessages) {
  await ctx.db.patch(receipt._id, { status: "failed", failure });
  const project = await ctx.db.get(receipt.projectId);
  if (!project) return;
  await scheduleMrNote(ctx, { key: noteKeys.commandVerification(receipt._id), gitlabProjectId: project.gitlabProjectId,
    projectPath: project.path, mrIid: receipt.command.mrIid, provider: "fred",
    body: `Finding command could not be verified: ${failureMessages[failure]} No finding was changed. Post a new command after the problem is corrected.` });
}

async function retryReceipt(ctx: MutationCtx, receipt: Receipt) {
  const delay = RETRY_DELAYS_MS[receipt.attempts - 1];
  if (delay === undefined) return failReceipt(ctx, receipt, "exhausted");
  await ctx.db.patch(receipt._id, { status: "pending", nextAttemptAt: Date.now() + delay });
  await ctx.scheduler.runAfter(delay, internal.findingCommandRequests.dispatch, { requestId: receipt._id });
}

export const dispatch = internalMutation({
  args: requestArgs,
  handler: async (ctx, args) => {
    const receipt = await ctx.db.get(args.requestId);
    if (!receipt || !["pending", "verifying"].includes(receipt.status) || receipt.nextAttemptAt > Date.now()) return;
    if (receipt.status === "verifying") return retryReceipt(ctx, receipt);
    const attempt = receipt.attempts + 1;
    await ctx.db.patch(receipt._id, { status: "verifying", attempts: attempt, nextAttemptAt: Date.now() + ATTEMPT_TIMEOUT_MS });
    await ctx.scheduler.runAfter(ATTEMPT_TIMEOUT_MS, internal.findingCommandRequests.dispatch, args);
    await ctx.scheduler.runAfter(0, internal.findingCommandRequests.verify, { ...args, attempt });
  },
});

function ownsAttempt(receipt: Receipt | null, attempt: number): receipt is Receipt {
  return receipt !== null && receipt.status === "verifying" && receipt.attempts === attempt && receipt.nextAttemptAt > Date.now();
}

// The receipt, its project, and that project's verification access while `attempt` still owns the receipt; null otherwise.
export const current = internalQuery({
  args: attemptArgs,
  handler: async (ctx, args) => {
    const receipt = await ctx.db.get(args.requestId);
    if (!ownsAttempt(receipt, args.attempt)) return null;
    const project = await ctx.db.get(receipt.projectId);
    const credential = project ? await projectCredential(ctx, project) : null;
    return { receipt, project, access: { token: credential?.token ?? null, botIds: await botUserIds(ctx) } };
  },
});

export const finish = internalMutation({
  args: { ...attemptArgs, outcome: v.union(
    v.object({ kind: v.literal("authorized") }),
    v.object({ kind: v.literal("denied") }),
    v.object({ kind: v.literal("ignored") }),
    v.object({ kind: v.literal("retry") }),
    v.object({ kind: v.literal("failed"), reason: v.union(v.literal("configuration"), v.literal("gitlab")) }),
  ) },
  handler: async (ctx, args) => {
    const receipt = await ctx.db.get(args.requestId);
    if (!ownsAttempt(receipt, args.attempt)) return;
    if (args.outcome.kind === "retry") return retryReceipt(ctx, receipt);
    if (args.outcome.kind === "failed") return failReceipt(ctx, receipt, args.outcome.reason);
    const project = await ctx.db.get(receipt.projectId);
    if (args.outcome.kind === "ignored" || !project) {
      await ctx.db.patch(receipt._id, { status: "ignored" });
      return;
    }
    const { body: _, ...command } = receipt.command;
    await ctx.runMutation(internal.findingCommands.enqueue, { ...command, gitlabProjectId: project.gitlabProjectId, noteId: receipt.noteId,
      ...(args.outcome.kind === "denied" ? { rejection: "Only the MR author or a project Maintainer can change findings." } : {}),
    });
    await ctx.db.patch(receipt._id, { status: "done" });
  },
});

// Runs one verification attempt of a receipt against GitLab and records its outcome. `fetcher` replaces fetch in tests.
export async function verifyRequest(ctx: ActionCtx, requestId: Id<"findingCommandRequests">, attempt: number, fetcher: typeof fetch = fetch): Promise<void> {
  const current = await ctx.runQuery(internal.findingCommandRequests.current, { requestId, attempt });
  if (!current) return;
  const { receipt, project, access } = current;
  const outcome = project ? await authorizeFindingCommand({ ...receipt.command, noteId: receipt.noteId, gitlabProjectId: project.gitlabProjectId },
    access, fetcher) : { kind: "ignored" } as const;
  await ctx.runMutation(internal.findingCommandRequests.finish, { requestId, attempt, outcome });
}

export const verify = internalAction({
  args: attemptArgs,
  handler: (ctx, args) => verifyRequest(ctx, args.requestId, args.attempt),
});
