import { stage1Output, stage2Output } from "@fred/contracts";
import { mkdtemp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Deferred, Effect, Layer } from "effect";
import { expect, it } from "vitest";
import fixture from "../../../../fixtures/reviews/basic.json";
import type { Id } from "../../../controller/convex/_generated/dataModel";
import { GitLab } from "../gitlab";
import { buildResult } from "../result";
import { fixtureJob, gitlabLayer, testServices } from "../testLayers";
import { Controller, type ClaimedCommand, type ClaimedJob, type ClaimedWork } from "../controller";
import type { DevelopmentState } from "./backend";
import { FixtureGit, fixtureContext } from "../fixtures";
import { FixtureProvider } from "./fixtures";
import { Git } from "../git";
import { ReviewProvider, type UsageSnapshot } from "../provider";
import { Diagnostics, type DiagnosticInput } from "../diagnostics/recorder";
import { serve } from "./http";
import { openPublications, type Publications } from "./publications";
import { developmentEndpoint, developmentPort, verificationRequest } from "./schema";
import { assessVerification, recoverPrevious } from "./verification";
import { makeDiffCatalog } from "../diffCatalog";
import { openWorkspace } from "../sandbox/workspace";

const emptyState = (): DevelopmentState => ({ jobs: [], findings: [], usage: [], notes: [], diagnostics: [], snapshots: [] });

it("recovers saved publication before another verification without replaying model calls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fred-local-recover-"));
  try {
    const services = testServices();
    const result = await Effect.runPromise(buildResult({ jobId: "fixture-job", botUserIds: [3], candidates: stage1Output.parse(fixture.detect).candidates,
      validation: stage2Output.parse(fixture.validate), previous: [], context: fixtureContext, hints: [] }));
    const publication = { ...fixtureJob, status: "publishing" as const, resultJson: JSON.stringify(result) };
    const jobs: ClaimedJob[] = [publication, fixtureJob];
    const controller = Controller.of({ ...services.controller, claim: () => Effect.sync(() => jobs.shift() ?? null) });
    const captures = await Effect.runPromise(openPublications(join(directory, "publications.jsonl")));
    await Effect.runPromise(recoverPrevious(captures).pipe(Effect.provideService(Controller, controller), Effect.provide(services.layers)));
    expect(services.calls).toContain("complete");
    expect(services.calls.filter((call) => call.startsWith("ack:"))).toHaveLength(result.effects.length);
    expect(captures.inspect().map((row) => row.kind)).toEqual(["summary", "finding", "label"]);
    expect(services.calls).toContain("interruptAnalysis");
    expect(services.calls).not.toContain("detect");
    expect(services.calls).not.toContain("validate");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("recovers a queued finding command before continuing to an interrupted review", async () => {
  const services = testServices();
  const command: ClaimedCommand = {
    kind: "finding_command", _id: "command-1" as Id<"findingCommands">, _creationTime: 1,
    projectId: fixtureJob.projectId, mrIid: 1, provider: "fred", noteId: "11", actorId: "42",
    action: "dismiss", findingId: "finding-1" as Id<"findings">, expectedDecisionRef: null, reason: "Intentional.",
    status: "running", publicationAcks: [], workerId: "fixture-worker", leaseToken: "command-lease", leaseGeneration: 1, leaseExpiresAt: 200_000,
    gitlabProjectId: "1", gitlabBotUserId: "3", gitlabBotUserIds: ["3"], gitlabToken: "fixture-token",
  };
  const work: ClaimedWork[] = [command, fixtureJob];
  const acknowledgements: string[] = [];
  const controller = Controller.of({ ...services.controller,
    claim: () => Effect.sync(() => work.shift() ?? null),
    forCommand: () => ({
      heartbeat: () => Effect.succeed({ leaseExpiresAt: 200_000 }),
      context: () => Effect.succeed([]), reconcileSummary: () => Effect.succeed(null),
      prepare: () => Effect.succeed(JSON.stringify({ body: "Dismissed.", resolved: true, label: "clean" })),
      acknowledge: (effect) => Effect.sync(() => { acknowledgements.push(effect); return null; }),
      fail: () => Effect.die("Finding command recovery failed"),
    }),
  });
  const captures: Publications = { inspect: () => [], layer: () => gitlabLayer(services.gitlab) };
  await Effect.runPromise(recoverPrevious(captures).pipe(Effect.provideService(Controller, controller), Effect.provide(services.layers)));
  expect(acknowledgements).toEqual(["decision", "label"]);
  expect(services.calls).toEqual(["summary", "label", "interruptAnalysis"]);
  expect(work).toEqual([]);
});

it("does not enqueue new verification while previous work retains a lease", async () => {
  const services = testServices();
  const controller = Controller.of({ ...services.controller, ready: () => Effect.succeed([fixtureJob]) });
  const captures: Publications = { inspect: () => [], layer: () => gitlabLayer(services.gitlab) };
  await expect(Effect.runPromise(recoverPrevious(captures).pipe(Effect.provideService(Controller, controller), Effect.provide(services.layers))))
    .rejects.toThrow("Earlier work still holds a lease");
});

it("reports a malformed control response without leaking its body or an unhandled rejection", async () => {
  const server = createServer((_request, response) => response.end("private-invalid-response"));
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(developmentPort, "127.0.0.1", resolve); });
  try {
    const result = await new Promise<{ code: string | number | null | undefined; stdout: string; stderr: string }>((resolve) => {
      execFile(process.execPath, ["--import", "tsx/esm", "src/dev/client.ts", "inspect"], {
        cwd: fileURLToPath(new URL("../../", import.meta.url)), env: { WORKER_SECRET: "local-test" },
      }, (error, stdout, stderr) => resolve({ code: error?.code, stdout, stderr }));
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Local development request failed\n");
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

it("requires the accepted counter defect even when an empty live review finishes", async () => {
  const result = await Effect.runPromise(buildResult({ jobId: "fixture-job", botUserIds: [3], candidates: [],
    validation: { verdicts: [], findingDecisions: [] }, previous: [], context: fixtureContext, hints: [] }));
  const state = emptyState();
  state.jobs.push({ ...fixtureJob, status: "done", resultJson: JSON.stringify(result),
    publicationAcks: result.effects.map((effect) => ({ key: effect.key })) });
  const assertions = assessVerification(state, fixtureJob._id, "success", [], { stages: ["detect", "validate"] });
  expect(assertions).toMatchObject({ completedJob: true, storedResult: true, acceptedCounterDefect: false });
  expect(Object.values(assertions).every(Boolean)).toBe(false);
});

it("distinguishes persisted failure comments from a failed job with no comment", () => {
  const state = emptyState();
  state.jobs.push({ ...fixtureJob, status: "failed" });
  expect(assessVerification(state, fixtureJob._id, "provider-failure", []).storedFailureNote).toBe(false);
  state.notes.push({ _id: "note" as Id<"mrNotes">, _creationTime: 1, jobId: fixtureJob._id, key: "failure",
    gitlabProjectId: "1", projectPath: "fixtures/example", mrIid: 1, provider: "fred", body: "AI review failed: provider failure",
    status: "pending", attempts: 0 });
  expect(Object.values(assessVerification(state, fixtureJob._id, "provider-failure", [])).every(Boolean)).toBe(true);
});

it("retains captured publication markers after reopening without duplicating a summary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fred-local-capture-"));
  try {
    const path = join(directory, "publications.jsonl");
    const scope = { projectId: 1, mrIid: 1, botUserIds: [902], token: "fixture" };
    const write = (capture: Publications) => Effect.gen(function* () {
      const gitlab = (yield* GitLab).forMr(scope);
      return yield* gitlab.publishSummary({ marker: "stable-marker", body: "counter defect" });
    }).pipe(Effect.provide(capture.layer("run-1")));
    const initial = await Effect.runPromise(openPublications(path));
    const first = await Effect.runPromise(write(initial));
    const reopened = await Effect.runPromise(openPublications(path));
    const second = await Effect.runPromise(write(reopened));
    expect(first).toEqual(second);
    expect(reopened.inspect()).toHaveLength(1);
    expect(reopened.inspect()[0]?.body).toBe("counter defect");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("interrupts active provider work when the verification client disconnects", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const interrupted = yield* Deferred.make<void>();
    yield* serve({ secret: "local-test", health: () => ({ ready: true, sourceHash: "test", verifying: false }),
      inspect: Effect.succeed({ sourceHash: "test", verifying: false, ...emptyState(), publications: [] }),
      verify: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined).pipe(Effect.asVoid))),
    });
    const abort = new AbortController();
    const request = fetch(`${developmentEndpoint}/verify`, { method: "POST", body: "{}", signal: abort.signal,
      headers: { Authorization: "Bearer local-test" } }).catch(() => undefined);
    yield* Deferred.await(started);
    abort.abort();
    yield* Deferred.await(interrupted);
    yield* Effect.promise(() => request);
  })));
});

it("accepts OpenRouter models and requires only its token for live checks", () => {
  expect(verificationRequest.safeParse({ live: "openrouter", model: "google/gemini-3.1-pro-preview", effort: "default", keys: { OPENROUTER_API_TOKEN: "secret" } }).success).toBe(true);
  expect(verificationRequest.safeParse({ live: "openrouter", scenario: "large-diff", keys: { OPENROUTER_API_TOKEN: "secret" } }).success).toBe(true);
  expect(verificationRequest.safeParse({ live: "openrouter", keys: { OPENROUTER_API_TOKEN: "secret", WORKER_SECRET: "extra" } }).success).toBe(false);
  expect(verificationRequest.safeParse({ live: "openrouter" }).success).toBe(false);
  expect(verificationRequest.safeParse({ live: "openrouter", scenario: "provider-failure", keys: { OPENROUTER_API_TOKEN: "secret" } }).success).toBe(false);
  expect(verificationRequest.safeParse({ keys: { OPENROUTER_API_TOKEN: "secret" } }).success).toBe(false);
});

it("accepts the persisted fixture defect and every acknowledged captured effect", async () => {
  const result = await Effect.runPromise(buildResult({ jobId: "fixture-job", botUserIds: [3], candidates: stage1Output.parse(fixture.detect).candidates,
    validation: stage2Output.parse(fixture.validate), previous: [], context: fixtureContext, hints: [] }));
  const state = emptyState();
  state.jobs.push({ ...fixtureJob, status: "done", resultJson: JSON.stringify(result), publicationAcks: result.effects.map((effect) => ({ key: effect.key })) });
  state.findings.push(...result.findings.map((finding, index) => ({ file: finding.file, title: finding.title, body: finding.body, severity: finding.severity,
    status: "posted" as const, _id: `finding-${index}` as Id<"findings">,
    _creationTime: 1, jobId: fixtureJob._id, projectId: fixtureJob.projectId, mrIid: 1, provider: "fred" as const })));
  state.usage.push({ _id: "usage" as Id<"usageEvents">, _creationTime: 1, jobId: fixtureJob._id, developerId: fixtureJob.developerId,
    month: "2026-09", provider: "fred", model: "fixture", stage: "detect", inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, costUsd: 0, priceTableVersion: "fixture" });
  const common = { id: "capture", runId: "run", mrIid: 1, provider: "fred" as const, at: 1 };
  expect(Object.values(assessVerification(state, fixtureJob._id, "success", [
    { ...common, kind: "summary" }, { ...common, kind: "label", label: "findings" },
  ], { stages: ["detect", "validate"] })).every(Boolean)).toBe(true);
});

it("simulates HTTP while running the SDK tool loop and accumulating both responses", async () => {
  const usage: UsageSnapshot[] = [];
  const diagnostics: DiagnosticInput[] = [];
  const result = await Effect.runPromise(Effect.gen(function* () {
    const provider = yield* ReviewProvider;
    const checkout = yield* (yield* Git).checkout({ url: fixtureContext.cloneUrl, sha: fixtureJob.headSha, token: "fixture-token" });
    return yield* provider.run({
      stage: "detect", workspace: yield* openWorkspace(checkout.path), secrets: [], prompt: "Review the counter fixture", diffCatalog: makeDiffCatalog(fixtureContext),
      model: "google/gemini-3.1-pro-preview", effort: "default", schema: stage1Output, toolSchema: stage1Output,
      onUsage: (sample) => Effect.sync(() => { usage.push(sample); }),
    });
  }).pipe(Effect.provide(Layer.merge(FixtureGit, FixtureProvider("success"))),
    Effect.provideService(Diagnostics, { emit: (event) => { diagnostics.push(event); } }), Effect.scoped));
  expect(result.output).toEqual(fixture.detect);
  expect(result.usageConfirmed).toBe(true);
  expect(usage.at(-1)).toMatchObject({ inputTokens: 200, outputTokens: 20, costUsd: 0, final: true });
  expect(diagnostics).toContainEqual(expect.objectContaining({ kind: "tool_completed", tool: "read", outcome: "success" }));
});
