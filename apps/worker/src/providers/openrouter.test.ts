import { stage1Output, stage2Output } from "@fred/contracts";
import { HTTPClient, type Fetcher } from "@openrouter/sdk/lib/http";
import { Cause, Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { StageInput, StageTranscript, UsageSnapshot } from "../provider";
import { ControllerError } from "../errors";
import { classifyFailure } from "../diagnostics/failure";
import { Diagnostics, type DiagnosticInput } from "../diagnostics/recorder";
import { runOpenRouterStage } from "./openrouter";
import { makeDiffCatalog } from "../diffCatalog";
import { chatCompletion, toolCall as call } from "../fixtures";
import { validationToolSchema } from "../result";
import { openWorkspace } from "../sandbox/workspace";
const emptyDiffs = makeDiffCatalog({ fullDiff: [], reviewDiff: [] });

const checkouts: string[] = [];
afterEach(async () => { await Promise.all(checkouts.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function checkout() {
  const path = await mkdtemp(join(tmpdir(), "fred-openrouter-fixture-"));
  checkouts.push(path);
  await writeFile(join(path, "source.ts"), "export const original = true;\n");
  return path;
}
const workspace = async (path?: string) => Effect.runPromise(openWorkspace(path ?? await checkout()));

const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0.025 };
const completion = (calls = [call("submit_review", { candidates: [] })], finish = "tool_calls") => chatCompletion({ calls, finish, usage });
// A response that ends with assistant text and no tool calls.
const textStop = (content: string, finish = "stop") => {
  const response = completion([], finish);
  return { ...response, choices: [{ ...response.choices[0], message: { role: "assistant", content } }] };
};

// Routes the real SDK into deterministic HTTP responses; no imported modules are mocked.
async function run(responses: Response[], overrides: Partial<StageInput<z.infer<typeof stage1Output>>> = {}) {
  const path = await checkout();
  const observations: UsageSnapshot[] = [];
  const requests: { url: string; redirect: string; body: unknown }[] = [];
  const transport = new HTTPClient({ fetcher: async (source, init) => {
    const request = new Request(source, init);
    requests.push({ url: request.url, redirect: request.redirect, body: await request.json() });
    const response = responses.shift();
    if (!response) throw new Error("Synthetic HTTP responses exhausted");
    return response;
  } });
  const input = {
    stage: "detect" as const, workspace: await workspace(path), diffCatalog: emptyDiffs, secrets: [],
    prompt: "Synthetic review only", model: "synthetic/review-model", effort: "high" as const, schema: stage1Output, toolSchema: stage1Output,
    onUsage: (sample: UsageSnapshot) => Effect.sync(() => { observations.push(sample); }), ...overrides,
  };
  const events: DiagnosticInput[] = [];
  const stage = runOpenRouterStage(input, "synthetic-api-token", transport).pipe(
    Effect.provideService(Diagnostics, { emit: (event) => { events.push(event); } }),
  );
  const result = await Effect.runPromiseExit(responses.length > 1 ? onTestClock(stage) : stage);
  return { result, observations, requests, events, path };
}

// Runs a stage on the test clock, advancing it between event-loop turns until the stage ends, so retry delays pass without sleeping.
const onTestClock = <A, E>(stage: Effect.Effect<A, E>) => Effect.gen(function* () {
  const fiber = yield* Effect.forkChild(stage);
  while (fiber.pollUnsafe() === undefined) {
    yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
    yield* TestClock.adjust("1 second");
  }
  return yield* Fiber.join(fiber);
}).pipe(Effect.provide(TestClock.layer({})));

const failure = (result: Awaited<ReturnType<typeof run>>["result"]) => {
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure") return Cause.squash(result.cause);
  return undefined;
};

describe("OpenRouter SDK review runtime", () => {
  it.each(["anthropic/claude-fable-5.1", "openai/gpt-6-astra", "z-ai/glm-5.3-flash"])("enables automatic caching on every tool round for %s", async (model) => {
    const result = await run([
      Response.json(completion([call("read", { path: "source.ts" })])),
      Response.json(completion()),
    ], { model });
    expect(result.result).toMatchObject({ _tag: "Success" });
    expect(result.requests).toHaveLength(2);
    for (const request of result.requests) {
      expect(request.body).toHaveProperty("cache_control", { type: "ephemeral" });
    }
  });

  it("keeps typed OpenRouter rejection details and actual wire sizes through the adapter", async () => {
    const result = await run([Response.json({ error: { code: 400, message: "Provider returned error", metadata: {
      error_type: "string_too_long", raw: "private source must never enter diagnostics",
    } } }, { status: 400 })]);
    expect(failure(result.result)).toMatchObject({ diagnostic: {
      provider: { source: "openrouter", code: "string_too_long" }, httpStatus: 400,
      request: { messageCount: 2, bytes: expect.any(Number), largestMessageCharacters: expect.any(Number) },
    } });
    expect(result.events).toContainEqual(expect.objectContaining({ kind: "api_rejected", failure: expect.objectContaining({ request: expect.any(Object) }) }));
    expect(result.events).toContainEqual(expect.objectContaining({ kind: "api_rejected", failure: expect.objectContaining({ detail: expect.stringContaining("Provider returned error") }) }));
  });

  it("runs the tool loop, preserves reasoning, and acknowledges cumulative actual-model usage", async () => {
    const fixtures: unknown[] = JSON.parse(await readFile(new URL("../../../../fixtures/openrouter/read-and-submit.json", import.meta.url), "utf8"));
    const runResult = await run(fixtures.map((fixture) => Response.json(fixture)));
    expect(runResult.result).toMatchObject({ _tag: "Success", value: { output: { candidates: [] }, usageConfirmed: true } });
    expect(runResult.observations).toEqual([
      { inputTokens: 50, cachedInputTokens: 40, cacheCreationInputTokens: 10, outputTokens: 20, costUsd: 0.025, model: "synthetic/review-model", final: false },
      { inputTokens: 230, cachedInputTokens: 40, cacheCreationInputTokens: 10, outputTokens: 30, costUsd: 0.035, model: "synthetic/review-model", final: false },
      { inputTokens: 230, cachedInputTokens: 40, cacheCreationInputTokens: 10, outputTokens: 30, costUsd: 0.035, model: "synthetic/review-model", final: true },
    ]);
    expect(runResult.requests).toHaveLength(2);
    expect(runResult.requests[0]).toMatchObject({ url: "https://openrouter.ai/api/v1/chat/completions", redirect: "error", body: {
      model: "synthetic/review-model", reasoning: { effort: "high" }, provider: { require_parameters: true },
      tools: expect.arrayContaining([expect.objectContaining({ function: expect.objectContaining({ name: "submit_review" }) })]),
    } });
    expect(runResult.requests[1]?.body).toMatchObject({ messages: expect.arrayContaining([
      { role: "assistant", content: null, reasoning: "Synthetic reasoning fixture.", reasoning_details: [
        { type: "reasoning.text", text: "Inspect the checkout.", signature: "synthetic-signature", index: 0 },
        { type: "reasoning.encrypted", data: "synthetic-encrypted-reasoning", index: 1 },
      ], tool_calls: expect.any(Array) },
      { role: "tool", tool_call_id: "read-source", content: expect.stringContaining("export const original = true;") },
      { role: "tool", tool_call_id: "denied-write", content: expect.stringContaining("not permitted") },
    ]) });
    expect(await readFile(join(runResult.path, "source.ts"), "utf8")).toBe("export const original = true;\n");
    expect(runResult.result).toMatchObject({ value: { hints: [expect.stringContaining("missing-review-skill")] } });
  });

  it("supports both stage contracts through flat validation tool fields", async () => {
    const candidates = [{ file: "source.ts", severity: "should_fix", title: "Synthetic finding", body: "Synthetic evidence" }];
    const detection = await run([Response.json(completion([call("submit_review", { candidates })]))]);
    expect(detection.result).toMatchObject({ _tag: "Success", value: { output: { candidates } } });
    const output = { verdicts: [{ index: 0, verdict: "accepted" }, { index: 1, verdict: "rejected", reason: "Checked" }, { index: 2, verdict: "duplicate", reason: "Existing" }], findingDecisions: [] };
    const result = await Effect.runPromise(runOpenRouterStage({
      stage: "validate", workspace: await workspace(), diffCatalog: emptyDiffs, model: "anthropic/claude-fable-5.1", effort: "default", prompt: "Synthetic",
      schema: stage2Output, toolSchema: validationToolSchema, secrets: [], onUsage: () => Effect.void,
    }, "synthetic-api-token", new HTTPClient({ fetcher: async (source, init) => {
      const request: unknown = await new Request(source, init).json();
      expect(request).not.toHaveProperty("reasoning");
      expect(request).toHaveProperty("cache_control", { type: "ephemeral" });
      expect(request).toMatchObject({ tools: expect.arrayContaining([expect.objectContaining({ function: expect.objectContaining({
        name: "submit_review", parameters: expect.objectContaining({ properties: expect.objectContaining({ verdicts: { type: "array", items: expect.objectContaining({ type: "object", required: ["index", "verdict"], properties: expect.objectContaining({ verdict: { type: "string", enum: ["accepted", "rejected", "duplicate"] }, reason: expect.objectContaining({ type: "string" }) }) }) } }) }),
      }) })]) });
      return Response.json(completion([call("submit_review", output)]));
    } })));
    expect(result.output).toEqual(output);
  });

  it.each(["stop", "length", "content_filter", "error", "unknown"])("rejects %s even with a valid submission and first preserves returned usage", async (finish) => {
    const result = await run([Response.json(completion(undefined, finish))]);
    expect(failure(result.result)).toMatchObject({ _tag: "ProviderError" });
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({ costUsd: 0.025, final: false });
  });

  it.each([
    { calls: [call("submit_review", { candidates: "invalid" })], code: "schema_mismatch" },
    { calls: [{ ...call("submit_review", {}), function: { name: "submit_review", arguments: "{" } }], code: "invalid_json" },
    { calls: [call("submit_review", { candidates: [] }), call("read", { path: "source.ts" })], code: "mixed_submission" },
  ])("classifies terminal $code after one repair round without publishing a result", async ({ calls, code }) => {
    const result = await run([Response.json(completion(calls)), Response.json(completion(calls))]);
    expect(failure(result.result)).toMatchObject({ _tag: "ParseError", diagnostic: { category: "output", provider: { source: "openrouter", code } } });
    expect(result.requests).toHaveLength(2);
    expect(result.observations.at(-1)?.final).toBe(false);
  });

  it("feeds a rejected submission back to the model once and accepts the corrected result", async () => {
    const invalid = call("submit_review", { candidates: [{ file: "source.ts", severity: "must_fix", title: "Synthetic", body: "Synthetic" }] }, "first-submission");
    const result = await run([Response.json(completion([invalid])), Response.json(completion())]);
    expect(result.result).toMatchObject({ _tag: "Success", value: { output: { candidates: [] }, usageConfirmed: true } });
    expect(result.requests[1]?.body).toMatchObject({ messages: expect.arrayContaining([
      { role: "tool", tool_call_id: "first-submission", content: expect.stringMatching(/submit_review was rejected[\s\S]*severity[\s\S]*call submit_review again/) },
    ]) });
    expect(result.events).toContainEqual({ kind: "submission_rejected", phase: "detect", failure: { category: "output", provider: { source: "openrouter", code: "schema_mismatch", validationIssues: [{ code: "invalid_value", path: ["candidates", 0, "severity"] }] } } });
  });

  it("bounds validation diagnostics to issue kinds and known contract paths, excluding model content and arbitrary keys", async () => {
    const candidate = { file: "private-source.ts", title: "private-title", body: "private-source-content", severity: "private-secret-value" };
    const rejected = completion([call("submit_review", { candidates: [candidate] })]);
    const result = await run([Response.json(rejected), Response.json(rejected)]);
    const error = failure(result.result);
    expect(error).toMatchObject({ diagnostic: { provider: { validationIssues: [{ code: "invalid_value", path: ["candidates", 0, "severity"] }] } } });
    expect(JSON.stringify(error)).not.toContain("private-");
    const schema = stage1Output.superRefine((_value, context) => {
      for (let index = 0; index < 12; index++) context.addIssue({ code: "custom", path: [`private-key-${index}`], message: "private-prompt-content" });
    });
    const invalid = await run([Response.json(completion()), Response.json(completion())], { schema });
    const bounded = failure(invalid.result);
    expect(bounded).toMatchObject({ diagnostic: { provider: { validationIssues: Array.from({ length: 8 }, () => ({ code: "custom", path: [] })) } } });
    expect(JSON.stringify(bounded)).not.toContain("private-");
  });

  it.each([undefined, null])("marks missing cost %s as a gap and still records later reported charges", async (cost) => {
    const first = completion([call("read", { path: "source.ts" })]);
    const second = completion([call("read", { path: "source.ts" })]);
    const last = completion();
    const result = await run([Response.json(first), Response.json({ ...second, usage: { ...usage, cost } }), Response.json(last)]);
    expect(result.result).toMatchObject({ _tag: "Success", value: { usageConfirmed: false } });
    expect(result.observations.map((sample) => sample.costUsd)).toEqual([0.025, undefined, 0.05]);
    expect(result.observations.every((sample) => !sample.final)).toBe(true);
  });

  it("records a reported cost even when prompt accounting or the served model does not fit the snapshot", async () => {
    const odd = { ...usage, prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 10 } };
    const result = await run([Response.json({ ...completion(), usage: odd, model: "not a model id" })]);
    expect(result.result).toMatchObject({ _tag: "Success", value: { usageConfirmed: true } });
    expect(result.observations[0]).toEqual({ inputTokens: 0, cachedInputTokens: 40, cacheCreationInputTokens: 10, outputTokens: 20, costUsd: 0.025, final: false });
  });

  it.each(["first", "last"])("never confirms a stage with missing %s response usage", async (missing) => {
    const first = completion([call("read", { path: "source.ts" })]);
    const last = completion();
    const result = await run([
      Response.json({ ...first, usage: missing === "first" ? undefined : usage }),
      Response.json({ ...last, usage: missing === "last" ? undefined : usage }),
    ]);
    expect(result.result).toMatchObject({ _tag: "Success", value: { usageConfirmed: false } });
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]?.final).toBe(false);
  });

  it("asks once for the submission after a text-only stop and accepts the submission that follows", async () => {
    const result = await run([Response.json(textStop("The review found no issues.")), Response.json(completion())]);
    expect(result.result).toMatchObject({ _tag: "Success", value: { output: { candidates: [] }, usageConfirmed: true } });
    expect(result.requests[1]?.body).toMatchObject({ messages: expect.arrayContaining([
      { role: "assistant", content: "The review found no issues." },
      { role: "user", content: expect.stringContaining("You ended without calling submit_review") },
    ]) });
    expect(result.events).toContainEqual({ kind: "submission_rejected", phase: "detect", failure: { category: "output", code: "missing_result" } });
  });

  it("fails a second text-only stop from its finish reason and keeps the model's text as detail only", async () => {
    const said = "Found invalid JSON in source.ts; the model output is invalid";
    const result = await run([Response.json(textStop("Still reviewing.")), Response.json(textStop(said))]);
    expect(result.requests).toHaveLength(2);
    const classified = classifyFailure(failure(result.result), []);
    expect(classified).toEqual({ category: "provider", detail: expect.stringContaining(`output content ${JSON.stringify(said)}`) });
    expect(classified.detail).toContain("ended without a complete review tool call (finish reason stop, 0 tool calls, served model synthetic/review-model)");
  });

  it("fails a truncated text response without asking for the submission", async () => {
    const result = await run([Response.json(textStop("The review was cut", "length"))]);
    expect(failure(result.result)).toMatchObject({ _tag: "ProviderError", message: expect.stringContaining("exhausted the model context or output limit") });
    expect(result.requests).toHaveLength(1);
  });

  it("preserves usage before an HTTP error and keeps only redacted failure text without retrying", async () => {
    const key = `sk-or-v1-${"a".repeat(64)}`;
    const result = await run([Response.json({ error: { message: `unauthorized key ${key}`, code: 401 }, usage, model: "synthetic/review-model" }, { status: 401 })]);
    const error = failure(result.result);
    expect(error).toMatchObject({ _tag: "ProviderError", diagnostic: { category: "authentication", httpStatus: 401, detail: "unauthorized key [redacted]" } });
    expect(result.observations[0]).toMatchObject({ costUsd: 0.025, final: false });
    expect(result.requests).toHaveLength(1);
  });

  it.each([
    ["an upstream overload inside an HTTP-200 body", () => Response.json({ error: { message: "Our servers are currently overloaded.", metadata: { error_type: "provider_unavailable" } }, usage })],
    ["an HTTP 429 rate limit", () => Response.json({ error: { message: "Rate limit exceeded", code: 429 }, usage }, { status: 429 })],
    ["an HTTP 500 server error", () => Response.json({ error: { message: "Internal Server Error", code: 500 }, usage }, { status: 500 })],
  ])("sends the same request again after %s and records each attempt's usage", async (_, transient) => {
    const result = await run([transient(), transient(), Response.json(completion())]);
    expect(result.result).toMatchObject({ _tag: "Success" });
    expect(result.requests).toHaveLength(3);
    expect(result.requests[2]?.body).toEqual(result.requests[0]?.body);
    expect(result.observations.at(-1)).toMatchObject({ costUsd: expect.closeTo(0.075), inputTokens: 300, final: true });
  });

  it("fails the stage after three retries of a transient failure", async () => {
    const overloaded = () => Response.json({ error: { message: "Overloaded", metadata: { error_type: "provider_overloaded" } } });
    const result = await run([overloaded(), overloaded(), overloaded(), overloaded()]);
    expect(failure(result.result)).toMatchObject({ _tag: "ProviderError", retryable: true, diagnostic: { provider: { code: "serverOverloaded" } } });
    expect(result.requests).toHaveLength(4);
  });

  it("rejects an HTTP-200 error even when the SDK can parse a valid submission", async () => {
    const result = await run([Response.json({ ...completion(), error: { message: "Provider failed" } })]);
    expect(failure(result.result)).toMatchObject({ _tag: "ProviderError" });
    expect(result.observations).toHaveLength(1);
  });

  it("preserves usage when SDK response validation fails", async () => {
    const result = await run([Response.json({ ...completion(), choices: "invalid" })]);
    expect(failure(result.result)).toMatchObject({ _tag: "ProviderError" });
    expect(result.observations[0]).toMatchObject({ costUsd: 0.025 });
  });

  it("stops before tool continuation if usage cannot be acknowledged", async () => {
    let transcript: StageTranscript | undefined;
    const result = await run([Response.json(completion([call("read", { path: "source.ts" })]))], {
      onUsage: () => Effect.fail(new ControllerError({ message: "Usage not acknowledged" })),
      onTranscript: (live) => { transcript = live; },
    });
    expect(failure(result.result)).toMatchObject({ _tag: "ControllerError" });
    expect(result.requests).toHaveLength(1);
    expect(transcript?.messages.at(-1)).toMatchObject({ role: "assistant", toolCalls: [{ id: "read" }] });
  });

  it("keeps the raw response message in the transcript when the SDK rejects its envelope", async () => {
    let transcript: StageTranscript | undefined;
    const result = await run([Response.json({ ...completion([call("read", { path: "source.ts" })]), created: "not-a-timestamp" })], {
      onTranscript: (live) => { transcript = live; },
    });
    expect(failure(result.result)).toMatchObject({ _tag: "ProviderError" });
    expect(transcript?.messages.at(-1)).toMatchObject({ role: "assistant", tool_calls: [{ id: "read", function: { name: "read" } }] });
  });

  it("keeps a raw response message whose own tool calls are malformed", async () => {
    let transcript: StageTranscript | undefined;
    const response = completion([call("read", { path: "source.ts" })]);
    const malformed = { ...response, choices: [{ ...response.choices[0], message: { role: "assistant", content: "reasoning", tool_calls: { id: "read" } } }] };
    const result = await run([Response.json(malformed)], { onTranscript: (live) => { transcript = live; } });
    expect(failure(result.result)).toMatchObject({ _tag: "ProviderError" });
    expect(transcript?.messages.at(-1)).toMatchObject({ role: "assistant", content: "reasoning", tool_calls: { id: "read" } });
  });

  it("aborts the in-flight SDK HTTP request when the stage is interrupted", async () => {
    const started = await Effect.runPromise(Deferred.make<void>());
    let aborted = false;
    const fetcher: Fetcher = (source, init) => new Promise((_resolve, reject) => {
      const request = new Request(source, init);
      request.signal.addEventListener("abort", () => { aborted = true; reject(new DOMException("Aborted", "AbortError")); }, { once: true });
      Effect.runSync(Deferred.succeed(started, undefined));
    });
    const fiber = Effect.runFork(runOpenRouterStage({
      stage: "detect", workspace: await workspace(), diffCatalog: emptyDiffs, model: "synthetic/review-model", effort: "none", prompt: "Synthetic",
      schema: stage1Output, toolSchema: stage1Output, secrets: [], onUsage: () => Effect.void,
    }, "synthetic-api-token", new HTTPClient({ fetcher })));
    await Effect.runPromise(Deferred.await(started));
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(aborted).toBe(true);
  });
});
