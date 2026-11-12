import { failureSummary } from "@fred/contracts";
import { ConvexError } from "convex/values";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it, vi } from "vitest";
import { controllerCall, makeController } from "./controller";
import { classifyFailure } from "./diagnostics/failure";
import { makeDiagnosticRecorder } from "./diagnostics/recorder";
import { fixtureJob } from "./testLayers";

type Client = Parameters<typeof makeController>[0];

describe("controller queue notifications", () => {
  it.each([true, false])("wakes only on connection recovery or queue events (initially connected: %s)", (initiallyConnected) => {
    let state: ReturnType<Client["connectionState"]> = {
      isWebSocketConnected: initiallyConnected,
      hasEverConnected: initiallyConnected,
      hasInflightRequests: false,
      timeOfOldestInflightRequest: null,
      connectionCount: initiallyConnected ? 1 : 0,
      connectionRetries: 0,
      inflightMutations: 0,
      inflightActions: 0,
    };
    const unsubscribeQueue = Object.assign(vi.fn(), {
      unsubscribe: vi.fn(),
      getCurrentValue: () => undefined,
      getQueryLogs: () => undefined,
    });
    const unsubscribeConnection = vi.fn();
    const client = {
      connectionState: () => state,
      subscribeToConnectionState: vi.fn<Client["subscribeToConnectionState"]>().mockReturnValue(unsubscribeConnection),
      onUpdate: vi.fn<Client["onUpdate"]>().mockReturnValue(unsubscribeQueue),
      query: vi.fn<Client["query"]>(),
      mutation: vi.fn<Client["mutation"]>(),
      action: vi.fn<Client["action"]>(),
    } satisfies Client;
    const wake = vi.fn();
    const stop = Effect.runSync(makeController(client, "fixture-secret", "fixture-worker").watch(wake));
    const notify = client.subscribeToConnectionState.mock.calls[0]![0];
    const updateState = (changes: Partial<typeof state>) => {
      state = { ...state, ...changes };
      notify(state);
    };

    notify(state);
    updateState({ hasInflightRequests: true, inflightMutations: 1, timeOfOldestInflightRequest: new Date(0) });
    updateState({ hasInflightRequests: false, inflightMutations: 0, timeOfOldestInflightRequest: null });
    updateState({ isWebSocketConnected: false });
    updateState({ connectionRetries: 1 });
    expect(wake).not.toHaveBeenCalled();

    updateState({ isWebSocketConnected: true, hasEverConnected: true, connectionCount: state.connectionCount + 1 });
    expect(wake).toHaveBeenCalledExactlyOnceWith();
    updateState({ hasInflightRequests: true, inflightMutations: 1 });
    updateState({ hasInflightRequests: false, inflightMutations: 0 });
    expect(wake).toHaveBeenCalledTimes(1);

    updateState({ isWebSocketConnected: false });
    updateState({ isWebSocketConnected: true, connectionCount: state.connectionCount + 1 });
    expect(wake).toHaveBeenCalledTimes(2);

    const [, , onQueueUpdate, onQueueError] = client.onUpdate.mock.calls[0]!;
    onQueueUpdate([]);
    expect(wake).toHaveBeenLastCalledWith([]);
    expect(wake).toHaveBeenCalledTimes(3);
    onQueueError!(new Error("fixture subscription error"));
    expect(wake).toHaveBeenLastCalledWith();
    expect(wake).toHaveBeenCalledTimes(4);

    stop();
    expect(unsubscribeQueue).toHaveBeenCalledOnce();
    expect(unsubscribeConnection).toHaveBeenCalledOnce();
  });
});

const connectionState = {
  isWebSocketConnected: true, hasEverConnected: true, hasInflightRequests: false,
  timeOfOldestInflightRequest: null, connectionCount: 1, connectionRetries: 0, inflightMutations: 0, inflightActions: 0,
};

function transport() {
  return {
    connectionState: () => connectionState,
    subscribeToConnectionState: vi.fn<Client["subscribeToConnectionState"]>(),
    onUpdate: vi.fn<Client["onUpdate"]>(), query: vi.fn<Client["query"]>(), mutation: vi.fn<Client["mutation"]>(), action: vi.fn<Client["action"]>(),
  } satisfies Client;
}

describe("controller request recovery", () => {
  it.each([true, false])("bounds a single outstanding request and classifies its timeout (connected: %s)", async (connected) => {
    const call = vi.fn(() => new Promise<null>(() => {}));
    await Effect.runPromise(Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(controllerCall("jobs:recordUsage", call, () => connected).pipe(Effect.flip));
      yield* TestClock.adjust("14 seconds");
      expect(fiber.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("1 second");
      expect(classifyFailure(yield* Fiber.join(fiber), [])).toEqual({ category: "controller", controller: {
        operation: "jobs:recordUsage", reason: connected ? "timeout" : "disconnected", elapsedMs: 15_000, connected,
      }, detail: `ControllerError: Controller jobs:recordUsage ${connected ? "timeout" : "disconnected"}` });
      expect(call).toHaveBeenCalledOnce();
    }).pipe(Effect.provide(TestClock.layer({}))));
  });

  it.each([
    [new ConvexError({ code: "lease_lost", message: "job lease lost" }), "lease_lost", 1],
    [new ConvexError("Server error: write conflict"), "rejected", 1],
    [new Error("Server error: write conflict"), "rejected", 3],
  ] as const)("classifies exhausted or tagged rejection and keeps its text as detail only", async (cause, reason, attempts) => {
    const call = vi.fn(() => Promise.reject(cause));
    await Effect.runPromise(Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(controllerCall("jobs:heartbeat", call, () => true).pipe(Effect.flip));
      yield* TestClock.adjust("1 second");
      const error = yield* Fiber.join(fiber);
      expect(classifyFailure(error, [])).toMatchObject({ category: "controller", controller: { operation: "jobs:heartbeat", reason, connected: true } });
      expect(classifyFailure(error, []).detail).toContain(`caused by ${cause.name}: ${cause.message}`);
      expect(failureSummary(classifyFailure(error, []))).not.toContain(cause.message);
      expect(call).toHaveBeenCalledTimes(attempts);
    }).pipe(Effect.provide(TestClock.layer({}))));
  });

  it("recovers a settled untagged rejection within the original wait budget", async () => {
    const call = vi.fn<() => Promise<null>>().mockRejectedValueOnce(new Error("write conflict")).mockResolvedValueOnce(null);
    await Effect.runPromise(Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(controllerCall("jobs:recordUsage", call, () => true));
      yield* TestClock.adjust("100 millis");
      expect(yield* Fiber.join(fiber)).toBeNull();
      expect(call).toHaveBeenCalledTimes(2);
    }).pipe(Effect.provide(TestClock.layer({}))));
  });

  it("keeps the original deadline when a retry remains pending", async () => {
    const call = vi.fn<() => Promise<null>>().mockRejectedValueOnce(new Error("write conflict")).mockImplementation(() => new Promise(() => {}));
    await Effect.runPromise(Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(controllerCall("jobs:heartbeat", call, () => true, { budgetMs: 500 }).pipe(Effect.flip));
      yield* TestClock.adjust("500 millis");
      expect(classifyFailure(yield* Fiber.join(fiber), [])).toMatchObject({ controller: { reason: "timeout", elapsedMs: 500 } });
      expect(call).toHaveBeenCalledTimes(2);
    }).pipe(Effect.provide(TestClock.layer({}))));
  });

  it("bounds diagnostic requests across jobs even after a flush times out and another job finishes", async () => {
    const client = transport();
    const resolves: ((value: null) => void)[] = [];
    client.mutation.mockImplementation(() => new Promise<null>((resolve) => resolves.push(resolve)));
    const controller = makeController(client, "test", "worker");
    const recorders = [1, 2, 3, 4].map((leaseGeneration) => makeDiagnosticRecorder({
      leaseGeneration, journal: () => {}, send: controller.forJob({ ...fixtureJob, leaseGeneration }).recordDiagnostics,
    }));
    await Effect.runPromise(Effect.gen(function* () {
      for (const recorder of recorders) {
        recorder.emit({ kind: "phase_started", phase: "detect" });
        const fiber = yield* Effect.forkChild(recorder.finish);
        yield* TestClock.adjust("1 second");
        yield* Fiber.join(fiber);
      }
      expect(client.mutation).toHaveBeenCalledOnce();
      expect(recorders.every((recorder) => recorder.snapshot().droppedEvents > 0)).toBe(true);
      resolves[0]!(null);
      yield* Effect.promise(() => Promise.resolve());
      client.mutation.mockResolvedValue(null);
      yield* recorders[3]!.flush;
      expect(client.mutation).toHaveBeenCalledTimes(2);
    }).pipe(Effect.provide(TestClock.layer({}))));
  });

  it("shortens the wait to the confirmed lease and uses renewed ownership for later operations", async () => {
    const client = transport();
    const control = () => makeController(client, "test", "worker").forJob({ ...fixtureJob, leaseExpiresAt: 6_000 });
    await Effect.runPromise(Effect.gen(function* () {
      client.mutation.mockImplementation(() => new Promise<null>(() => {}));
      const fiber = yield* Effect.forkChild(control().saveResult("{}").pipe(Effect.flip));
      yield* TestClock.adjust("5 seconds");
      expect(classifyFailure(yield* Fiber.join(fiber), [])).toMatchObject({ controller: { operation: "jobs:saveResult", reason: "timeout", elapsedMs: 5_000 } });
    }).pipe(Effect.provide(TestClock.layer({}))));
    await Effect.runPromise(Effect.gen(function* () {
      const renewed = control();
      client.mutation.mockResolvedValueOnce({ leaseExpiresAt: 120_000, publicationCurrent: true });
      yield* renewed.heartbeat();
      yield* TestClock.adjust("10 seconds");
      client.mutation.mockResolvedValueOnce(null);
      yield* renewed.saveResult("{}");
      expect(client.mutation).toHaveBeenCalledTimes(3);
    }).pipe(Effect.provide(TestClock.layer({}))));
  });

  it("waits for a claim without a deadline", async () => {
    const client = transport();
    let resolve: (value: null) => void = () => {};
    client.mutation.mockImplementation(() => new Promise<null>((settle) => { resolve = settle; }));
    await Effect.runPromise(Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(makeController(client, "test", "worker").claim());
      yield* TestClock.adjust("1 hour");
      expect(fiber.pollUnsafe()).toBeUndefined();
      resolve(null);
      expect(yield* Fiber.join(fiber)).toBeNull();
    }).pipe(Effect.provide(TestClock.layer({}))));
  });
});
