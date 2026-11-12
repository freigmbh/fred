import { controllerOperation, type DiagnosticFailure } from "@fred/contracts";
import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import { randomUUID } from "node:crypto";
import { ConvexClient } from "convex/browser";
import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";
import { Clock, Context, Effect, Layer, Schedule } from "effect";
import { api } from "../../controller/convex/_generated/api";
import { WorkerConfig } from "./config";
import { ControllerError, DiagnosticSlotBusy } from "./errors";

export type ClaimedWork = NonNullable<FunctionReturnType<typeof api.jobs.claim>>;
export type ClaimedJob = Extract<ClaimedWork, { kind: "review" }>;
export type ClaimedCommand = Extract<ClaimedWork, { kind: "finding_command" }>;
export type PreviousFinding = FunctionReturnType<typeof api.jobs.previousFindings>[number];
export type QueueState = FunctionReturnType<typeof api.jobs.listQueued>;
type Client = Pick<ConvexClient, "query" | "mutation" | "action" | "onUpdate" | "connectionState" | "subscribeToConnectionState">;

const recoveryWindowMs = 15_000;
const leaseMarginMs = 1_000;
// Pause between heartbeats of a review or finding command: four renewals per two-minute lease, so a slow renewal still lands long before expiry.
export const heartbeatInterval = "30 seconds";
type Operation = NonNullable<DiagnosticFailure["controller"]>["operation"];

// Calls the controller with recovery: settled untagged errors retry up to `retries` times within `budgetMs`, and a pending
// request is never replaced. An infinite budget waits for the controller as long as it takes.
export const controllerCall = <A>(operation: Operation, call: () => Promise<A>, connected: () => boolean, { budgetMs = recoveryWindowMs, retries = 2 }: { budgetMs?: number; retries?: number } = {}) => Effect.gen(function* () {
  const started = yield* Clock.currentTimeMillis;
  const failure = (reason: NonNullable<DiagnosticFailure["controller"]>["reason"], cause?: unknown) => Effect.gen(function* () {
    const elapsedMs = Math.max(0, (yield* Clock.currentTimeMillis) - started);
    return yield* Effect.fail(new ControllerError({ message: `Controller ${operation} ${reason}`, cause,
      diagnostic: { category: "controller", controller: { operation, reason, elapsedMs, connected: connected() } } }));
  });
  if (budgetMs <= 0) return yield* failure("timeout");
  const settled = Effect.tryPromise({ try: call, catch: (cause) => cause }).pipe(
    Effect.retry({ times: retries, schedule: Schedule.exponential("100 millis"), while: (cause) => !(cause instanceof ConvexError) }),
    Effect.catch((cause) => {
      const data = typeof cause === "object" && cause !== null && "data" in cause ? cause.data : undefined;
      const leaseLost = typeof data === "object" && data !== null && "code" in data && data.code === "lease_lost";
      return failure(leaseLost ? "lease_lost" : "rejected", cause);
    }),
  );
  if (!Number.isFinite(budgetMs)) return yield* settled;
  return yield* settled.pipe(Effect.timeoutOrElse({ duration: budgetMs, orElse: () => failure(!connected() ? "disconnected" : "timeout") }));
});

// The worker's controller client. A `fredVersion` is stamped on saved results and usage rows.
export const makeController = (client: Client, workerSecret: string, workerId: string, fredVersion?: string) => {
  const connected = () => client.connectionState().isWebSocketConnected;
  const request = <A>(name: string, call: () => Promise<A>, budgetMs = recoveryWindowMs) => {
    const operation = controllerOperation.safeParse(name);
    return operation.success ? controllerCall(operation.data, call, connected, { budgetMs })
      : Effect.fail(new ControllerError({ message: "Unsupported controller operation" }));
  };
  const mutate = <M extends FunctionReference<"mutation">>(ref: M, args: FunctionArgs<M>, budgetMs = recoveryWindowMs) =>
    request(getFunctionName(ref), () => client.mutation(ref, args), budgetMs);
  const query = <Q extends FunctionReference<"query">>(ref: Q, args: FunctionArgs<Q>) =>
    request(getFunctionName(ref), () => client.query(ref, args));
  let diagnosticRequest: Promise<unknown> | undefined;
  const queueArgs = { workerSecret, providers: ["fred" as const] };
  const stamp = fredVersion ? { fredVersion } : {};
  const isConnected = Effect.sync(() => client.connectionState().isWebSocketConnected);
  const waitOnline = Effect.callback<void>((resume) => {
    if (client.connectionState().isWebSocketConnected) { resume(Effect.void); return; }
    const dispose = client.subscribeToConnectionState((state) => { if (state.isWebSocketConnected) resume(Effect.void); });
    return Effect.sync(dispose);
  });
  const leasedMutations = (initialExpiry: number) => {
    let leaseExpiresAt = initialExpiry;
    // The recovery window, shortened so an owned call never outlives the lease it relies on.
    const leaseBudget = Clock.currentTimeMillis.pipe(Effect.map((now) => Math.min(recoveryWindowMs, leaseExpiresAt - now - leaseMarginMs)));
    const owned = <M extends FunctionReference<"mutation">>(ref: M, args: FunctionArgs<M>) => leaseBudget.pipe(Effect.flatMap((budgetMs) => mutate(ref, args, budgetMs)));
    const renew = (lease: { leaseExpiresAt: number }) => Effect.sync(() => { leaseExpiresAt = lease.leaseExpiresAt; });
    return { owned, renew, leaseBudget };
  };
  const forJob = (job: ClaimedJob) => {
    const auth = { workerSecret, jobId: job._id, leaseToken: job.leaseToken };
    const { owned, renew, leaseBudget } = leasedMutations(job.leaseExpiresAt ?? 0);
    const recordDiagnostics = (eventsJson: string, snapshotJson: string) => Effect.gen(function* () {
      if (diagnosticRequest) return yield* new DiagnosticSlotBusy();
      return yield* controllerCall("diagnostics:record", () => {
        const request = client.mutation(api.diagnostics.record, { ...auth, eventsJson, snapshotJson });
        diagnosticRequest = request;
        const settled = () => { diagnosticRequest = undefined; };
        void request.then(settled, settled);
        return request;
      }, connected, { retries: 0 });
    });
    return {
      heartbeat: () => owned(api.jobs.heartbeat, auth).pipe(Effect.tap(renew)),
      previousFindings: () => query(api.jobs.previousFindings, { workerSecret, jobId: job._id }),
      saveResult: (resultJson: string) => owned(api.jobs.saveResult, { ...auth, resultJson, ...stamp }),
      acknowledge: (effectKey: string, discussionId?: string, noteId?: string) => owned(api.jobs.ackPublication, { ...auth, effectKey, ...(discussionId ? { discussionId } : {}), ...(noteId ? { noteId } : {}) }),
      complete: () => owned(api.jobs.complete, auth),
      supersede: () => owned(api.jobs.supersede, auth),
      skip: () => owned(api.jobs.skip, auth),
      fail: (failureReason: FunctionArgs<typeof api.jobs.fail>["failureReason"], message: string, diagnosticJson?: string) => mutate(api.jobs.fail, { ...auth, failureReason, message, ...(diagnosticJson ? { diagnosticJson } : {}) }),
      recordDiagnostics,
      interruptAnalysis: (message: string, diagnosticJson?: string) => mutate(api.jobs.interruptAnalysis, { ...auth, message, ...(diagnosticJson ? { diagnosticJson } : {}) }),
      recordUsage: (usage: Omit<FunctionArgs<typeof api.jobs.recordUsage>, keyof typeof auth>) => mutate(api.jobs.recordUsage, { ...auth, ...usage, ...stamp }),
      confirmUsage: (stage: "detect" | "validate") => mutate(api.jobs.confirmUsage, { ...auth, stage }),
      markUsageIncomplete: (reason: string) => mutate(api.jobs.markUsageIncomplete, { ...auth, reason }),
      storeTranscript: (transcript: Omit<FunctionArgs<typeof api.transcripts.store>, keyof typeof auth>) => leaseBudget.pipe(Effect.flatMap((budgetMs) =>
        request(getFunctionName(api.transcripts.store), () => client.action(api.transcripts.store, { ...auth, ...transcript }), budgetMs))),
    };
  };
  const forCommand = (command: ClaimedCommand) => {
    const auth = { workerSecret, commandId: command._id, leaseToken: command.leaseToken };
    const { owned, renew } = leasedMutations(command.leaseExpiresAt);
    return {
      heartbeat: () => owned(api.findingCommands.heartbeat, auth).pipe(Effect.tap(renew)),
      context: () => query(api.findingCommands.context, auth),
      reconcileSummary: (jobId: ClaimedJob["_id"], noteId: string) => owned(api.findingCommands.reconcileSummary, { ...auth, jobId, noteId }),
      prepare: () => owned(api.findingCommands.prepare, auth),
      acknowledge: (effect: "decision" | "label") => owned(api.findingCommands.acknowledge, { ...auth, effect }),
      fail: (message: string) => owned(api.findingCommands.fail, { ...auth, message }),
    };
  };
  return {
    isConnected, waitOnline, forJob, forCommand,
    // A claim waits for the controller and is never repeated, because a claim that timed out could still commit and strand its lease.
    claim: () => controllerCall("jobs:claim", () => client.mutation(api.jobs.claim, { ...queueArgs, workerId }), connected, { budgetMs: Number.POSITIVE_INFINITY, retries: 0 }),
    ready: () => query(api.jobs.listQueued, queueArgs),
    watch: (wake: (jobs?: QueueState) => void) => Effect.sync(() => {
      let connected = client.connectionState().isWebSocketConnected;
      const unsubscribe = client.onUpdate(api.jobs.listQueued, queueArgs, (jobs) => wake(jobs), () => wake());
      const disconnect = client.subscribeToConnectionState((state) => {
        const reconnected = state.isWebSocketConnected && !connected;
        connected = state.isWebSocketConnected;
        if (reconnected) wake();
      });
      return () => { unsubscribe(); disconnect(); };
    }),
  };
};

export type JobControl = ReturnType<ReturnType<typeof makeController>["forJob"]>;
export type CommandControl = ReturnType<ReturnType<typeof makeController>["forCommand"]>;
export class Controller extends Context.Service<Controller, ReturnType<typeof makeController>>()("fred/Controller") {}
export const ControllerLive = Layer.effect(Controller, Effect.gen(function* () {
  const config = yield* WorkerConfig;
  const client = yield* Effect.acquireRelease(
    Effect.sync(() => new ConvexClient(config.CONVEX_URL, { unsavedChangesWarning: false })),
    (client) => Effect.promise(() => client.close()),
  );
  return makeController(client, config.WORKER_SECRET, randomUUID(), config.FRED_VERSION);
}));
