import { Effect, Layer } from "effect";
import { diagnosticSnapshot, failureSummary } from "@fred/contracts";
import { describe, expect, it, vi } from "vitest";
import { Controller } from "../controller";
import { ControllerError, DiagnosticSlotBusy, ProviderError } from "../errors";
import { ReviewProvider } from "../provider";
import { requestFailure } from "../providers/requestDiagnostics";
import { runJob } from "../runJob";
import { fixtureJob, testServices } from "../testLayers";
import { classifyFailure, failureDetail } from "./failure";
import { Diagnostics, makeDiagnosticRecorder } from "./recorder";

describe("diagnostic privacy and evidence", () => {
  it("classifies nested transport causes and keeps the redacted cause chain as detail outside the summary", () => {
    const cause = Object.assign(new Error("fetch failed https://oauth2:glpat-secret@example.invalid/source"), {
      spawnargs: ["sk-ant-api03-0123456789abcdef"], cause: Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" }),
    });
    const failure = classifyFailure(new ProviderError({ message: "Claude review stream failed", cause }), []);
    expect(failure).toEqual({ category: "transport", code: "ECONNREFUSED",
      detail: "ProviderError: Claude review stream failed\n  caused by Error: fetch failed https://[redacted]@example.invalid/source\n  caused by Error: connect refused" });
    expect(failureSummary(failure)).toBe("Provider connection failed (ECONNREFUSED)");
  });

  it("redacts a configured secret that crosses the upstream excerpt bound", () => {
    const secret = "opaque-credential-0123456789abcdef";
    const detail = failureDetail({ message: "GitLab GET failed", body: `${"x".repeat(480)}${secret} tail` }, [secret]);
    expect(detail).toContain(`body ${"x".repeat(480)}[redacted]`);
    expect(detail).not.toContain("opaque-cred");
  });

  it("describes cyclic exceptions once and survives unreadable ones", () => {
    const cause: { message: string; cause?: unknown } = { message: "loop with Bearer private-token" };
    cause.cause = cause;
    expect(classifyFailure(cause, [])).toEqual({ category: "unexpected", detail: "loop with Bearer [redacted]" });
    expect(classifyFailure({ get message() { throw new Error("private"); } }, [])).toEqual({ category: "unexpected" });
  });

  it("treats HTTP 402 as exhausted quota without needing a recognizable message", () => {
    expect(classifyFailure({ status: 402, cause: { message: "upstream text" } }, [])).toEqual({ category: "quota", code: "insufficient_quota", httpStatus: 402, detail: "HTTP 402\n  caused by upstream text" });
  });
});

describe("best-effort diagnostic recording", () => {
  it("bounds buffered events, reports overflow, and drains every batch with the latest failure snapshot", async () => {
    let time = 1;
    const saved: unknown[] = [];
    const recorder = makeDiagnosticRecorder({ leaseGeneration: 2, now: () => time++, journal: () => {},
      send: (events, snapshot) => Effect.sync(() => { saved.push({ events: JSON.parse(events), snapshot: diagnosticSnapshot.parse(JSON.parse(snapshot)) }); }),
    });
    for (let index = 0; index < 200; index++) recorder.emit({ kind: "api_response", phase: "detect", httpStatus: 200 });
    recorder.emit({ kind: "failed", phase: "validate", failure: { category: "authentication" } });
    expect(recorder.pendingCount()).toBe(128);
    await Effect.runPromise(recorder.finish);
    expect(saved).toHaveLength(6);
    expect(saved[0]).toMatchObject({ events: expect.any(Array), snapshot: { phase: "validate", failure: { category: "authentication" }, droppedEvents: 73 } });
    expect(recorder.pendingCount()).toBe(0);
  });

  it("counts every unsent event when the final drain fails partway", async () => {
    let attempts = 0;
    const recorder = makeDiagnosticRecorder({ leaseGeneration: 1, now: () => 1, journal: () => {},
      send: () => Effect.suspend(() => ++attempts === 1 ? Effect.void : Effect.fail(new DiagnosticSlotBusy())),
    });
    for (let index = 0; index < 100; index++) recorder.emit({ kind: "api_response", phase: "detect", httpStatus: 200 });
    await Effect.runPromise(recorder.finish);
    expect(attempts).toBe(2);
    expect(recorder.pendingCount()).toBe(0);
    expect(recorder.snapshot().droppedEvents).toBe(75);
  });

  it("journals tool events without queueing them for the controller", () => {
    const journal: string[] = [];
    const recorder = makeDiagnosticRecorder({ leaseGeneration: 1, now: () => 5, journal: (event) => { journal.push(event.kind); }, send: () => Effect.void });
    recorder.emit({ kind: "tool_started", phase: "detect", tool: "read" });
    recorder.emit({ kind: "tool_completed", phase: "detect", tool: "read", outcome: "success" });
    expect(journal).toEqual(["tool_started", "tool_completed"]);
    expect(recorder.pendingCount()).toBe(0);
    expect(recorder.snapshot().lastActivityAt).toBe(5);
  });

  it("holds activity-only snapshots for a minute but sends a phase change on the next flush", async () => {
    let time = 0;
    const sent: unknown[] = [];
    const recorder = makeDiagnosticRecorder({ leaseGeneration: 1, now: () => time, journal: () => {},
      send: (events, snapshot) => Effect.sync(() => { sent.push({ events: JSON.parse(events), lastActivityAt: diagnosticSnapshot.parse(JSON.parse(snapshot)).lastActivityAt }); }),
    });
    recorder.emit({ kind: "phase_started", phase: "detect" });
    await Effect.runPromise(recorder.flush);
    time = 30_000;
    recorder.emit({ kind: "tool_completed", tool: "read", outcome: "success" });
    await Effect.runPromise(recorder.flush);
    expect(sent).toHaveLength(1);
    time = 40_000;
    recorder.emit({ kind: "phase_started", phase: "validate" });
    await Effect.runPromise(recorder.flush);
    expect(sent[1]).toMatchObject({ events: [{ kind: "phase_started", phase: "validate" }], lastActivityAt: 30_000 });
    time = 70_000;
    recorder.emit({ kind: "tool_completed", tool: "read", outcome: "success" });
    await Effect.runPromise(recorder.flush);
    time = 100_000;
    await Effect.runPromise(recorder.flush);
    expect(sent).toHaveLength(3);
    expect(sent[2]).toEqual({ events: [], lastActivityAt: 70_000 });
  });

  it("keeps observation time fresh while coalescing provider activity events", async () => {
    let time = 1;
    const recorder = makeDiagnosticRecorder({ leaseGeneration: 1, now: () => time, journal: () => {}, send: () => Effect.void });
    recorder.emit({ kind: "provider_activity", phase: "detect" });
    time = 9000;
    recorder.emit({ kind: "provider_activity", phase: "detect" });
    expect(recorder.pendingCount()).toBe(1);
    expect(recorder.snapshot().lastActivityAt).toBe(9000);
  });

  it("keeps events queued while another job holds the diagnostic slot and sends them on the next flush", async () => {
    let busy = true;
    const sent: unknown[] = [];
    const recorder = makeDiagnosticRecorder({ leaseGeneration: 1, journal: () => {},
      send: (events) => busy ? Effect.fail(new DiagnosticSlotBusy()) : Effect.sync(() => { sent.push(...JSON.parse(events)); }),
    });
    recorder.emit({ kind: "phase_started", phase: "detect" });
    await Effect.runPromise(recorder.flush);
    expect(recorder.pendingCount()).toBe(1);
    busy = false;
    await Effect.runPromise(recorder.flush);
    expect(sent).toMatchObject([{ kind: "phase_started", phase: "detect" }]);
    expect(recorder.snapshot().droppedEvents).toBe(0);
  });

  it("reports failed diagnostic writes without retrying or failing the caller", async () => {
    let calls = 0;
    const recorder = makeDiagnosticRecorder({ leaseGeneration: 1, journal: () => { throw new Error("journal unavailable"); },
      send: () => { calls++; return Effect.fail(new ControllerError({ message: "offline" })); },
    });
    recorder.emit({ kind: "phase_started", phase: "detect" });
    await Effect.runPromise(recorder.flush);
    expect(calls).toBe(1);
    expect(recorder.snapshot().droppedEvents).toBe(2);
  });

  it("completes a review when diagnostic storage fails", async () => {
    const test = testServices();
    const failing = Layer.succeed(Controller, { ...test.controller, forJob: () => ({ ...test.control,
      recordDiagnostics: () => Effect.fail(new ControllerError({ message: "offline diagnostic storage" })),
    }) });
    await Effect.runPromise(runJob(fixtureJob).pipe(Effect.provide(Layer.merge(test.layers, failing))));
    expect(test.calls).toContain("complete");
    expect(test.calls).not.toContain("fail");
  });

  it("stores a stage-specific sanitized failure and sends a safe MR explanation", async () => {
    const test = testServices();
    let snapshot: unknown;
    let message = "";
    const controller = Layer.succeed(Controller, { ...test.controller, forJob: () => ({ ...test.control,
      fail: (_reason, text) => Effect.sync(() => { message = text; return null; }),
      recordDiagnostics: (_events, json) => Effect.sync(() => { snapshot = JSON.parse(json); return null; }),
    }) });
    const provider = Layer.succeed(ReviewProvider, { run: () => Effect.fail(new ProviderError({ message: "Claude review stream failed",
      cause: new Error("invalid_api_key sk-ant-api03-0123456789abcdef PRIVATE_SOURCE"),
    })) });
    await Effect.runPromise(runJob(fixtureJob).pipe(Effect.provide(Layer.mergeAll(test.layers, controller, provider))));
    expect(snapshot).toMatchObject({ phase: "detect", failure: { category: "authentication", code: "invalid_api_key",
      detail: "ProviderError: Claude review stream failed\n  caused by Error: invalid_api_key [redacted] PRIVATE_SOURCE" } });
    expect(message).toContain("authentication");
    expect(message).not.toMatch(/PRIVATE_SOURCE|sk-ant-/);
  });

  it("preserves request sizes in terminal failure storage when diagnostic writes fail", async () => {
    const test = testServices();
    const request = { bytes: 17_200_000, messageCount: 2, largestMessageCharacters: 17_000_000 };
    const failure = requestFailure([], { message: "PRIVATE_SOURCE sk-private", metadata: { error_type: "context_length_exceeded" } }, 400, request);
    let terminal: unknown;
    let message = "";
    const controller = Layer.succeed(Controller, { ...test.controller, forJob: () => ({ ...test.control,
      recordDiagnostics: () => Effect.fail(new ControllerError({ message: "offline" })),
      fail: (_reason, text, json) => Effect.sync(() => { terminal = json === undefined ? undefined : JSON.parse(json); message = text; return null; }),
    }) });
    const failing = Layer.succeed(ReviewProvider, { run: () => Effect.fail(failure) });
    await Effect.runPromise(runJob(fixtureJob).pipe(Effect.provide(Layer.mergeAll(test.layers, controller, failing))));
    expect(terminal).toMatchObject({ phase: "detect", failure: { category: "invalid_request", provider: { source: "openrouter", code: "context_length_exceeded" }, request } });
    expect(message).toContain("input that exceeds the model context window");
    expect(message).not.toContain("PRIVATE_SOURCE");
    expect(terminal).toMatchObject({ failure: { detail: expect.stringContaining("PRIVATE_SOURCE") } });
  });
});

it("retains a provider failure before cleanup and includes it in the terminal write when diagnostic storage fails", async () => {
  const test = testServices();
  const failure = { category: "provider" as const, provider: { source: "openrouter" as const, code: "unknown" as const } };
  const order: string[] = [];
  let journalAtCleanup = "";
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  let terminal: unknown;
  let message = "";
  const controller = Layer.succeed(Controller, { ...test.controller, forJob: () => ({ ...test.control,
    recordDiagnostics: () => Effect.fail(new ControllerError({ message: "offline" })),
    fail: (_reason, text, json) => Effect.sync(() => { terminal = json === undefined ? undefined : JSON.parse(json); message = text; order.push("stored"); return null; }),
  }) });
  const provider = Layer.succeed(ReviewProvider, { run: () => Effect.gen(function* () {
    const diagnostics = yield* Diagnostics;
    yield* Effect.acquireRelease(Effect.void, () => Effect.sync(() => {
      order.push("cleanup");
      journalAtCleanup = stdout.mock.calls.map(([line]) => String(line)).join("");
      diagnostics.emit({ kind: "process_exited", failure: { category: "process", signal: "SIGKILL" } });
    }));
    return yield* new ProviderError({ message: "PRIVATE_SOURCE sk-private", diagnostic: failure });
  }) });
  try {
    await Effect.runPromise(runJob(fixtureJob).pipe(Effect.provide(Layer.mergeAll(test.layers, controller, provider))));
    expect(journalAtCleanup).toContain('"source":"' + failure.provider.source + '"');
    const records = stdout.mock.calls.flatMap(([line]) => {
      try { return [JSON.parse(String(line))]; } catch { return []; }
    });
    expect(records.filter((record) => record.fredDiagnostic === 1 && record.event.kind === "failed")).toHaveLength(1);
    expect(records).toContainEqual(expect.objectContaining({ fredDiagnostic: 1, jobId: fixtureJob._id, event: expect.objectContaining({ kind: "phase_started", phase: "detect" }) }));
    expect(records.filter((record) => record.fredFailure === 1)).toEqual([expect.objectContaining({
      jobId: fixtureJob._id, outcome: "failed", phase: "detect", trace: expect.stringContaining("ProviderError: PRIVATE_SOURCE"),
    })]);
  } finally { stdout.mockRestore(); }
  expect(order).toEqual(["cleanup", "stored"]);
  expect(terminal).toMatchObject({ phase: "detect", failure });
  expect(message).toContain(failure.provider.source);
  expect(message).not.toContain("PRIVATE_SOURCE");
  expect(JSON.stringify(terminal)).not.toContain("SIGKILL");
});
