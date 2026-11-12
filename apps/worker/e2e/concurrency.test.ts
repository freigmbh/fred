import { randomUUID } from "node:crypto";
import { ConvexClient, ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Doc, Id } from "../../controller/convex/_generated/dataModel";
import fixture from "../../../fixtures/reviews/basic.json";
import { WorkerConfig, readConfig } from "../src/config";
import { Controller, makeController, type ClaimedJob, type ClaimedWork } from "../src/controller";
import { Diagnostics } from "../src/diagnostics/recorder";
import { GitLabError, ProviderError } from "../src/errors";
import { fixtureEnvironment } from "../src/fixtures";
import { ReviewProvider } from "../src/provider";
import { runJob } from "../src/runJob";
import { gitlabLayer, testServices } from "../src/testLayers";
import { worker } from "../src/worker";

const url = process.env.FRED_E2E_URL;
const site = process.env.FRED_E2E_SITE;
const key = process.env.FRED_E2E_KEY;
if (!url || !site || !key) throw new Error("Run pnpm test:e2e to provision the isolated backend");
const admin = new ConvexHttpClient(url);
const setAdminAuth: unknown = Reflect.get(admin, "setAdminAuth");
if (typeof setAdminAuth !== "function") throw new Error("Convex fixture client lacks admin authentication");
setAdminAuth.call(admin, key);
const client = new ConvexClient(url, { unsavedChangesWarning: false });
const controller = makeController(client, "e2e-worker", "e2e-worker");
const auth = { workerSecret: "e2e-worker" };
const projectToken = "e2e-project-token";
const bot = { id: 901, username: "project_1_bot_e2e" };
const headSha = "a".repeat(40);
const state = makeFunctionReference<"query", Record<string, never>, {
  jobs: Doc<"reviewJobs">[]; usage: Doc<"usageEvents">[]; findings: Doc<"findings">[]; notes: Doc<"mrNotes">[];
}>("e2e:state");
const failStale = makeFunctionReference<"mutation", Record<string, never>, number>("stale:failStale");
const expire = makeFunctionReference<"mutation", { jobId: Id<"reviewJobs"> }, null>("e2e:expire");

beforeAll(async () => {
  await admin.mutation(makeFunctionReference<"mutation">("e2e:seed"), {});
  await admin.mutation(makeFunctionReference<"mutation", { token: string }>("e2e:connectFixture"), { token: projectToken });
});
afterAll(async () => { await client.close(); });

// Adds the project's FRED bot as reviewer through the real webhook.
async function enqueue(mrIid: number, deliveryKey = randomUUID()) {
  const response = await fetch(`${site}/webhook/gitlab`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Gitlab-Token": "e2e-hook", "Idempotency-Key": deliveryKey },
    body: JSON.stringify({ object_kind: "merge_request", user: { id: 2, username: "fixture" }, project: { id: 1, path_with_namespace: "fixtures/example" },
      object_attributes: { iid: mrIid, author_id: 2, action: "update", last_commit: { id: headSha } },
      changes: { reviewers: { previous: [], current: [bot] } }, reviewers: [bot] }),
  });
  expect(response.status).toBe(200);
  return response.json();
}

function requiredJob(job: ClaimedWork | null) {
  if (job?.kind !== "review") throw new Error("Expected queued E2E review");
  return job;
}

it("runs reviews of four MRs concurrently while usage, diagnostics, heartbeats and cleanup share the real backend", async ({ signal }) => {
  for (let i = 1; i <= 4; i++) await enqueue(i);
  const test = testServices();
  const shutdown = new AbortController();
  const claimed: ClaimedJob[] = [];
  let completed = 0;
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const allStarted = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let started = 0;
    const config = yield* readConfig(fixtureEnvironment({ WORKER_SECRET: "e2e-worker", WORKER_CONCURRENCY: "4" }));
    const service = Controller.of({ ...controller,
      claim: () => controller.claim().pipe(Effect.tap((job) => Effect.sync(() => { if (job) claimed.push(requiredJob(job)); }))),
      forJob: (job) => {
        const control = controller.forJob(job);
        return { ...control, complete: () => control.complete().pipe(Effect.tap(() => Effect.sync(() => { if (++completed === 4) shutdown.abort(); }))) };
      },
    });
    const provider = ReviewProvider.of({ run: (input) => Effect.gen(function* () {
      const diagnostics = yield* Diagnostics;
      if (input.stage === "detect") {
        if (++started === 4) yield* Deferred.succeed(allStarted, undefined);
        yield* Deferred.await(release);
      }
      for (let i = 1; i <= 40; i++) {
        diagnostics.emit({ kind: "api_response", httpStatus: 200 });
        yield* input.onUsage({ inputTokens: i * 100, cachedInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: i * 10, costUsd: i * 0.001, final: i === 40 });
      }
      return { output: input.schema.parse(fixture[input.stage]), usageConfirmed: true, hints: [] };
    }) });
    const fiber = yield* Effect.forkChild(worker(shutdown.signal).pipe(Effect.provide(Layer.mergeAll(test.layers,
      Layer.succeed(WorkerConfig, config), Layer.succeed(Controller, service), Layer.succeed(ReviewProvider, provider)))));
    yield* Deferred.await(allStarted);
    expect(claimed).toHaveLength(4);
    expect(new Set(claimed.map((job) => job.mrIid)).size).toBe(4);
    expect(claimed.every((job) => job.provider === "fred" && job.gitlabToken === projectToken && job.gitlabBotUserId === "901")).toBe(true);
    yield* Deferred.succeed(release, undefined);
    yield* Effect.all(claimed.map((job) => controller.forJob(job).heartbeat()), { concurrency: "unbounded" });
    yield* Effect.promise(() => Promise.all(Array.from({ length: 8 }, () => admin.mutation(failStale, {}))));
    yield* Fiber.join(fiber);
  })), { signal });
  const report = await admin.query(state, {});
  expect(report.jobs).toHaveLength(4);
  expect(report.jobs.every((job) => job.status === "done" && job.usageConfirmedStages?.length === 2 && !job.usageIncomplete)).toBe(true);
  expect(report.usage).toHaveLength(320);
  expect(report.usage.every((row) => row.priceTableVersion === "openrouter-reported-v1")).toBe(true);
  for (const job of report.jobs) expect(report.usage.filter((row) => row.jobId === job._id).reduce((sum, row) => sum + row.inputTokens, 0)).toBe(8000);
  expect(report.notes).toHaveLength(0);
});

it("recovers failed publication without another model call or duplicate summary", async () => {
  const mrIid = 20;
  await enqueue(mrIid);
  const job = requiredJob(await Effect.runPromise(controller.claim()));
  const test = testServices();
  const summaries: string[] = [];
  let rejectLabel = true;
  const gitlab = gitlabLayer({ ...test.gitlab,
    publishSummary: ({ marker }) => Effect.sync(() => { summaries.push(marker); return { noteId: "synthetic-note" }; }),
    setLabel: () => rejectLabel ? Effect.fail(new GitLabError({ message: "Synthetic permission failure", status: 403 })) : Effect.void,
  });
  const layers = Layer.mergeAll(test.layers, Layer.succeed(Controller, controller), gitlab);
  await Effect.runPromise(runJob(job).pipe(Effect.provide(layers)));
  expect((await admin.query(state, {})).jobs.find((row) => row._id === job._id)?.status).toBe("failed");
  const delivery = randomUUID();
  expect(await enqueue(mrIid, delivery)).toMatchObject({ result: "queued", jobId: job._id });
  expect(await enqueue(mrIid, delivery)).toMatchObject({ result: "duplicate" });
  const recovered = requiredJob(await Effect.runPromise(controller.claim()));
  expect(recovered._id).toBe(job._id);
  expect(recovered.status).toBe("publishing");
  rejectLabel = false;
  await Effect.runPromise(runJob(recovered).pipe(Effect.provide(Layer.merge(layers,
    Layer.succeed(ReviewProvider, { run: () => Effect.fail(new ProviderError({ message: "Recovery must use stored publication" })) })))));
  expect((await admin.query(state, {})).jobs.find((row) => row._id === job._id)?.status).toBe("done");
  expect(summaries).toHaveLength(1);
  expect(test.calls.filter((call) => ["detect", "validate"].includes(call))).toEqual(["detect", "validate"]);
});

it("expires lost analysis and creates a fresh attempt through a deliberate webhook", async () => {
  await enqueue(30);
  const job = requiredJob(await Effect.runPromise(controller.claim()));
  await admin.mutation(expire, { jobId: job._id });
  await admin.mutation(failStale, {});
  expect(await enqueue(30)).toMatchObject({ result: "queued" });
  const replacement = requiredJob(await Effect.runPromise(controller.claim()));
  expect(replacement._id).not.toBe(job._id);
  const test = testServices();
  await Effect.runPromise(runJob(replacement).pipe(Effect.provide(Layer.merge(test.layers, Layer.succeed(Controller, controller)))));
  const report = await admin.query(state, {});
  expect(report.jobs.find((row) => row._id === job._id)).toMatchObject({ status: "failed", usageIncomplete: true });
  expect(report.jobs.find((row) => row._id === replacement._id)?.status).toBe("done");
});
