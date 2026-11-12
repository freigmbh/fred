import { reviewResult, diagnosticSnapshot, type DiagnosticEvent } from "@fred/contracts";
import { HTTPClient } from "@openrouter/sdk/lib/http";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { gunzipSync } from "node:zlib";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { Controller } from "./controller";
import { ControllerError, GitLabError, ParseError } from "./errors";
import { chatCompletion, fixtureContext, toolCall } from "./fixtures";
import { GitLab, type ReviewScope } from "./gitlab";
import { ReviewProvider } from "./provider";
import { runOpenRouterStage } from "./providers/openrouter";
import { runJob, stageDeadline } from "./runJob";
import { fixtureJob, gitlabLayer, testServices } from "./testLayers";

const controllerFailure = (operation: "jobs:heartbeat" | "jobs:recordUsage" | "jobs:confirmUsage", reason: "rejected" | "disconnected") =>
  new ControllerError({ message: `Controller ${operation} ${reason}`, diagnostic: { category: "controller", controller: { operation, reason, elapsedMs: 1, connected: reason !== "disconnected" } } });

describe("review lifecycle", () => {
  it("fails oversized metadata in detect before calling a model", async () => {
    const test = testServices();
    const events: DiagnosticEvent[] = [];
    const oversized = gitlabLayer({ ...test.gitlab, loadContext: () => Effect.succeed({ ...fixtureContext, description: "x".repeat(256 * 1024) }) });
    const tracked = Layer.succeed(Controller, { ...test.controller, forJob: () => ({ ...test.control,
      recordDiagnostics: (eventsJson) => Effect.sync(() => { events.push(...JSON.parse(eventsJson)); return null; }),
    }) });
    await Effect.runPromise(runJob(fixtureJob).pipe(Effect.provide(oversized), Effect.provide(tracked), Effect.provide(test.layers)));
    expect(test.calls).toEqual(["incompleteUsage", "fail"]);
    expect(events).toContainEqual(expect.objectContaining({ kind: "failed", phase: "detect",
      failure: expect.objectContaining({ category: "invalid_request", code: "review_input_too_large" }),
    }));
  });

  it("supersedes an outdated head before validating a retired saved model", async () => {
    const test = testServices();
    const outdated = gitlabLayer({ ...test.gitlab, loadContext: () => Effect.succeed(undefined) });
    await Effect.runPromise(runJob({ ...fixtureJob, stageModels: {
      detect: { model: "retired-model", effort: "low" }, validate: { model: "openai/gpt-6-astra", effort: "medium" },
    } }).pipe(Effect.provide(outdated), Effect.provide(test.layers)));
    expect(test.calls).toEqual(["supersede"]);
  });

  it.each([true, false])("asks the controller to skip an unchanged head and analyses only when it refuses (skipped=%s)", async (skipped) => {
    const test = testServices();
    const unchanged = gitlabLayer({ ...test.gitlab, loadContext: () => Effect.succeed({ ...fixtureContext, reviewDiff: [], unchangedSinceBaseline: true }) });
    const refusing = Layer.succeed(Controller, { ...test.controller, forJob: () => ({ ...test.control,
      skip: () => Effect.sync(() => { test.calls.push("skip"); return { skipped }; }),
    }) });
    await Effect.runPromise(runJob(fixtureJob).pipe(Effect.provide(unchanged), Effect.provide(refusing), Effect.provide(test.layers)));
    expect(test.calls[0]).toBe("skip");
    expect(test.calls.includes("detect")).toBe(!skipped);
    if (!skipped) expect(test.saved()).toContain("did not complete");
  });

  it("redacts the claim's project token from stored failure detail", async () => {
    const test = testServices();
    const token = "opaque-project-token-0123456789";
    let stored = "";
    const leaking = gitlabLayer({ ...test.gitlab, loadContext: () => Effect.fail(new GitLabError({ message: "GitLab GET failed", body: `echoed credential ${token}` })) });
    const capturing = Layer.succeed(Controller, { ...test.controller, forJob: () => ({ ...test.control,
      fail: (_reason: string, message: string, diagnosticJson?: string) => Effect.sync(() => { stored = `${message} ${diagnosticJson ?? ""}`; return null; }),
    }) });
    await Effect.runPromise(runJob({ ...fixtureJob, gitlabToken: token }).pipe(Effect.provide(leaking), Effect.provide(capturing), Effect.provide(test.layers)));
    expect(stored).toContain("echoed credential [redacted]");
    expect(stored).not.toContain(token);
  });

  it("redacts the claim's project token from a stored transcript", async () => {
    const test = testServices();
    const token = "opaque-project-token-0123456789";
    const files: ArrayBuffer[] = [];
    const leaking = Layer.succeed(ReviewProvider, { run: (input) => Effect.suspend(() => {
      input.onTranscript?.({ startedAt: 1, tools: [], messages: [{ role: "tool", toolCallId: "read-1", content: `echoed credential ${token}` }], turns: [] });
      return Effect.fail(new ParseError({ message: "invalid stage output" }));
    }) });
    const capturing = Layer.succeed(Controller, { ...test.controller, forJob: () => ({ ...test.control,
      storeTranscript: (transcript) => Effect.sync(() => { if (transcript.file) files.push(transcript.file); return null; }),
    }) });
    await Effect.runPromise(runJob({ ...fixtureJob, gitlabToken: token, collectTranscripts: true }).pipe(
      Effect.provide(leaking), Effect.provide(capturing), Effect.provide(test.layers),
    ));
    const text = gunzipSync(Buffer.from(files[0] ?? new ArrayBuffer(0))).toString();
    expect(text).toContain("echoed credential [redacted]");
    expect(text).not.toContain(token);
  });

  it("fails an unsupported saved selection before starting either provider", async () => {
    const test = testServices();
    await Effect.runPromise(runJob({ ...fixtureJob, stageModels: {
      detect: { model: "retired-model", effort: "low" }, validate: { model: "openai/gpt-6-astra", effort: "medium" },
    } }).pipe(Effect.provide(test.layers)));
    expect(test.calls).toEqual(["fail"]);
  });

  it("fails a job without saved selections instead of falling back to defaults", async () => {
    const test = testServices();
    const { stageModels: _unselected, ...unselected } = fixtureJob;
    await Effect.runPromise(runJob(unselected).pipe(Effect.provide(test.layers)));
    expect(test.calls).toEqual(["fail"]);
  });

  it("uses the queued selections for OpenRouter calls, reported costs, and diagnostics", async () => {
    const test = testServices();
    const stageModels = { detect: { model: "anthropic/claude-fable-5.1", effort: "none" }, validate: { model: "google/gemini-3.5-flash", effort: "max" } };
    const observed: { stage: string; model: string; effort: string }[] = [];
    const usage: { stage: string; model: string; costUsd: number }[] = [];
    const events: DiagnosticEvent[] = [];
    const snapshots: string[] = [];
    const trackedProvider = Layer.succeed(ReviewProvider, { run: (input) => {
      observed.push({ stage: input.stage, model: input.model, effort: input.effort });
      return test.provider.run(input);
    } });
    const trackedController = Layer.succeed(Controller, { ...test.controller, forJob: () => ({ ...test.control,
      recordUsage: (row) => { usage.push(row); return test.control.recordUsage(); },
      recordDiagnostics: (eventsJson, snapshotJson) => {
        events.push(...JSON.parse(eventsJson));
        snapshots.push(snapshotJson);
        return Effect.succeed(null);
      },
    }) });
    await Effect.runPromise(runJob({ ...fixtureJob, stageModels }).pipe(
      Effect.provide(trackedProvider), Effect.provide(trackedController), Effect.provide(test.layers),
    ));
    expect(observed).toEqual([{ stage: "detect", ...stageModels.detect }, { stage: "validate", ...stageModels.validate }]);
    expect(usage.map(({ stage, model }) => ({ stage, model }))).toEqual([
      { stage: "detect", model: stageModels.detect.model }, { stage: "validate", model: stageModels.validate.model },
    ]);
    expect(usage.map(({ costUsd }) => costUsd)).toEqual([0.001, 0.001]);
    expect(snapshots.map((value) => diagnosticSnapshot.parse(JSON.parse(value))).at(-1)).toMatchObject(stageModels.validate);
    for (const stage of ["detect", "validate"] as const) expect(events).toContainEqual(expect.objectContaining({ phase: stage, ...stageModels[stage] }));
    expect(events.filter((event) => event.kind === "phase_started").map((event) => event.phase)).toEqual(["context", "checkout", "instructions", "detect", "validate", "save", "publish"]);
    expect(test.calls).toContain("complete");
  });

  it("cancels a stage at 45 minutes and releases its resources", async () => {
    await Effect.runPromise(Effect.gen(function* () {
      let released = false;
      const stage = stageDeadline(Effect.never.pipe(Effect.ensuring(Effect.sync(() => { released = true; }))));
      const fiber = yield* Effect.forkChild(stage.pipe(Effect.flip));
      yield* TestClock.adjust("44 minutes");
      expect(fiber.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("1 minute");
      expect((yield* Fiber.join(fiber))._tag).toBe("Timeout");
      expect(released).toBe(true);
    }).pipe(Effect.provide(TestClock.layer({}))));
  });

  it("cancels analysis after controller loss and reports it only after reconnect", async () => {
    const test = testServices();
    await Effect.runPromise(Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();
      const online = yield* Deferred.make<void>();
      const disconnected = Layer.succeed(Controller, { ...test.controller, forJob: () => ({ ...test.control,
        heartbeat: () => Deferred.await(started).pipe(Effect.andThen(Effect.fail(controllerFailure("jobs:heartbeat", "disconnected")))),
        interruptAnalysis: () => Deferred.await(online).pipe(Effect.andThen(test.control.interruptAnalysis())),
      }) });
      const provider = Layer.succeed(ReviewProvider, {
        run: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never), Effect.ensuring(Deferred.succeed(released, undefined))),
      });
      const fiber = yield* Effect.forkChild(runJob(fixtureJob).pipe(Effect.provide(provider), Effect.provide(disconnected), Effect.provide(test.layers)));
      yield* Deferred.await(released);
      expect(test.calls).not.toContain("interruptAnalysis");
      yield* Deferred.succeed(online, undefined);
      yield* Fiber.join(fiber);
      expect(test.calls).toContain("interruptAnalysis");
      expect(test.calls).not.toContain("fail");
      expect(test.calls).not.toContain("summary");
    }));
  });

  it("preserves confirmed usage when publication fails", async () => {
    const test = testServices();
    const broken = gitlabLayer({ ...test.gitlab, publishSummary: () => Effect.fail(new GitLabError({ message: "publication rejected", status: 403 })) });
    await Effect.runPromise(runJob(fixtureJob).pipe(Effect.provide(broken), Effect.provide(test.layers)));
    expect(test.calls.filter((call) => call === "confirmUsage")).toHaveLength(2);
    expect(test.calls).toContain("fail");
    expect(test.calls).not.toContain("incompleteUsage");
  });

  it.each(["recordUsage", "confirmUsage"] as const)("marks incomplete accounting before failing a rejected %s call", async (operation) => {
    const test = testServices();
    const rejected = Layer.succeed(Controller, { ...test.controller, forJob: () => ({ ...test.control,
      [operation]: () => Effect.fail(controllerFailure(`jobs:${operation}`, "rejected")),
    }) });
    await Effect.runPromise(runJob(fixtureJob).pipe(Effect.provide(rejected), Effect.provide(test.layers)));
    expect(test.calls.slice(-2)).toEqual(["incompleteUsage", "fail"]);
    expect(test.calls).not.toContain("save");
  });

  it("persists validated results before any GitLab publication", async () => {
    const test = testServices();
    await Effect.runPromise(runJob(fixtureJob).pipe(Effect.provide(test.layers)));
    expect(test.calls).toEqual(["detect", "usage", "confirmUsage", "validate", "usage", "confirmUsage", "save", "summary", "ack:summary", "inline", "ack:finding:0", "label", "ack:label", "complete"]);
    expect(reviewResult.parse(JSON.parse(test.saved()!)).findings[0]?.status).toBe("pending");
  });

  it("binds GitLab to the claim's head, project token, current bot, and former bots", async () => {
    const test = testServices();
    const bindings: ReviewScope[] = [];
    const bound = Layer.succeed(GitLab, { forMr: () => test.gitlab, forReview: (scope) => { bindings.push(scope); return test.gitlab; } });
    await Effect.runPromise(runJob({ ...fixtureJob, gitlabToken: "project-token", gitlabBotUserIds: ["2", "3"] }).pipe(
      Effect.provide(bound), Effect.provide(test.layers),
    ));
    expect(bindings).toEqual([{ projectId: 1, mrIid: 1, headSha: fixtureJob.headSha, previousReviewedSha: undefined, token: "project-token", botUserIds: [3, 2] }]);
  });

  it("resumes saved publication without cloning or calling either provider", async () => {
    const first = testServices();
    await Effect.runPromise(runJob(fixtureJob).pipe(Effect.provide(first.layers)));
    const resumed = testServices();
    await Effect.runPromise(runJob({ ...fixtureJob, status: "publishing", resultJson: first.saved()!, publicationAcks: [{ key: "summary" }],
      stageModels: { detect: { model: "retired-model", effort: "low" }, validate: { model: "retired-model", effort: "high" } },
    }).pipe(Effect.provide(resumed.layers)));
    expect(resumed.calls).toEqual(["inline", "ack:finding:0", "label", "ack:label", "complete"]);
  });

  it.each([true, false])("reconciles an uncertain summary before superseding a recovered publication (visible: %s)", async (visible) => {
    const first = testServices();
    await Effect.runPromise(runJob(fixtureJob).pipe(Effect.provide(first.layers)));
    const resumed = testServices();
    const stale = gitlabLayer({
      ...resumed.gitlab,
      isCurrent: () => Effect.succeed(false),
      findSummary: (marker: string) => Effect.sync(() => {
        expect(marker).toBe(`${fixtureJob._id}:summary`);
        resumed.calls.push("findSummary");
        return visible ? { noteId: "already-posted" } : undefined;
      }),
    });
    await Effect.runPromise(runJob({ ...fixtureJob, status: "publishing", resultJson: first.saved()! }).pipe(Effect.provide(stale), Effect.provide(resumed.layers)));
    expect(resumed.calls).toEqual(visible ? ["findSummary", "ack:summary", "supersede"] : ["findSummary", "supersede"]);
  });

  it("sends each stage one copy of a patch that is both scope and full MR", async () => {
    const test = testServices();
    const prompts: Partial<Record<"detect" | "validate", string>> = {};
    const captured = Layer.succeed(ReviewProvider, { run: (input) => { prompts[input.stage] = input.prompt; return test.provider.run(input); } });
    await Effect.runPromise(runJob(fixtureJob).pipe(Effect.provide(captured), Effect.provide(test.layers)));
    const patch = fixtureContext.fullDiff[0]!.diff;
    for (const stage of ["detect", "validate"] as const) expect(prompts[stage]?.split(patch)).toHaveLength(2);
  });

  it.each([true, false])("stores a failed stage's tool turn and generation ID only for a collecting job (collect: %s)", async (collectTranscripts) => {
    const test = testServices();
    const responses = [
      Response.json({ ...chatCompletion({ id: "gen-read", calls: [toolCall("read", { path: "src/counter.ts" }, "read-1")], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, cost: 0.001 } }), provider: "Synthetic Upstream" }),
      Response.json({ error: { code: 400, message: "Upstream rejected the request" } }, { status: 400 }),
    ];
    const transport = new HTTPClient({ fetcher: async () => responses.shift() ?? Response.json({}, { status: 500 }) });
    const openrouter = Layer.succeed(ReviewProvider, { run: (input) => runOpenRouterStage(input, "synthetic-api-token", transport) });
    const stored: { stage: string; outcome: string; turns: number; toolCalls: number; file?: ArrayBuffer }[] = [];
    const capturing = Layer.succeed(Controller, { ...test.controller, forJob: () => ({ ...test.control,
      storeTranscript: (transcript) => Effect.sync(() => { stored.push(transcript); test.calls.push("transcript"); return null; }),
    }) });
    await Effect.runPromise(runJob({ ...fixtureJob, ...(collectTranscripts ? { collectTranscripts } : {}) }).pipe(
      Effect.provide(openrouter), Effect.provide(capturing), Effect.provide(test.layers),
    ));
    expect(test.calls.filter((call) => call === "transcript" || call === "fail")).toEqual(collectTranscripts ? ["transcript", "fail"] : ["fail"]);
    if (!collectTranscripts) return;
    expect(stored).toMatchObject([{ stage: "detect", outcome: "failed", turns: 2, toolCalls: 1 }]);
    const file = JSON.parse(gunzipSync(Buffer.from(stored[0]?.file ?? new ArrayBuffer(0))).toString());
    expect(file.turns).toMatchObject([
      { httpStatus: 200, generationId: "gen-read", provider: "Synthetic Upstream", finishReason: "tool_calls" }, { httpStatus: 400 },
    ]);
    expect(file.messages).toContainEqual(expect.objectContaining({ role: "tool", toolCallId: "read-1" }));
  });

  it("does not publish when provider output is malformed", async () => {
    const test = testServices();
    const broken = Layer.succeed(ReviewProvider, { run: () => Effect.fail(new ParseError({ message: "invalid stage output" })) });
    await Effect.runPromise(runJob(fixtureJob).pipe(Effect.provide(broken), Effect.provide(test.layers)));
    expect(test.calls).toContain("fail");
    expect(test.calls).toContain("incompleteUsage");
    expect(test.calls).not.toContain("save");
    expect(test.calls).not.toContain("summary");
  });

  it("uses analysis-only interruption after an ambiguous save response", async () => {
    const test = testServices();
    const connectionLost = Layer.succeed(Controller, {
      ...test.controller,
      forJob: () => ({ ...test.control, saveResult: () => Effect.fail(new ControllerError({ message: "response lost" })) }),
    });
    await Effect.runPromise(runJob(fixtureJob).pipe(Effect.provide(connectionLost), Effect.provide(test.layers)));
    expect(test.calls).toContain("interruptAnalysis");
    expect(test.calls).not.toContain("fail");
    expect(test.calls).not.toContain("summary");
  });
});
