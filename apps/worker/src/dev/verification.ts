import { reviewFailureHeading, reviewResult } from "@fred/contracts";
import { randomUUID } from "node:crypto";
import { Effect, Layer } from "effect";
import { Controller, ControllerLive } from "../controller";
import { FixtureGit, fixtureContext } from "../fixtures";
import { maximumPromptBytes } from "../prompts";
import { ReviewProvider, type StageInput } from "../provider";
import { ReviewProviderLive } from "../providers/openrouter";
import { runJob } from "../runJob";
import { runFindingCommand } from "../runFindingCommand";
import { maximumPageBytes } from "../diffCatalog";
import type { DevelopmentBackend, DevelopmentState } from "./backend";
import { FixtureProvider, NoProvider } from "./fixtures";
import { completeCatalogRead, completeScopedRead, trackDiffReads, type CatalogRead, type DiffRead } from "./diffReads";
import { largeDiffFixture } from "./largeDiff";
import type { Publications } from "./publications";
import { DevelopmentError, type Scenario, type VerificationRequest } from "./schema";

type Stage = StageInput<unknown>["stage"];
type Captured = ReturnType<Publications["inspect"]>;
// Everything the provider wrapper records during one verification run, beyond what the backend stores.
type Observed = { stages: Stage[]; reads: DiffRead[]; listings: CatalogRead[]; promptBytes: number[] };
const bothStages = ["detect", "validate"] as const;

const coverage = {
  controller: "real local Convex", worker: "real claim, lease and runJob", git: "fixture directory", gitlab: "captured service calls",
  enqueue: "synthetic queued job; webhook and enqueue policy not exercised", failureNoteDelivery: "stored note only; HTTP delivery not exercised",
};

export function assessVerification(state: DevelopmentState, jobId: string, scenario: Scenario, captured: Captured, observed: Partial<Observed> = {}) {
  const { stages = [], reads = [], promptBytes = [], listings = [] } = observed;
  const job = state.jobs.find((row) => row._id === jobId);
  if (scenario === "provider-failure") return {
    failedJob: job?.status === "failed",
    storedFailureNote: state.notes.some((note) => note.jobId === jobId && note.body.includes(reviewFailureHeading)),
    noPublication: captured.length === 0,
  };
  const result = job?.resultJson === undefined ? undefined : reviewResult.safeParse(JSON.parse(job.resultJson));
  return {
    completedJob: job?.status === "done",
    completedStages: stages.includes("detect") && stages.includes("validate"),
    storedResult: result?.success === true,
    acceptedCounterDefect: state.findings.some((finding) => finding.jobId === jobId && finding.status === "posted" &&
      finding.file === "src/counter.ts" && /zero|\b0\b/i.test(`${finding.title} ${finding.body}`)),
    capturedSummary: captured.some((row) => row.kind === "summary"),
    capturedLabel: captured.some((row) => row.kind === "label" && row.label === "findings"),
    acknowledgedEffects: result?.success === true && result.data.effects.every((effect) => job?.publicationAcks?.some((ack) => ack.key === effect.key)),
    observedUsage: state.usage.some((row) => row.jobId === jobId),
    ...(scenario === "large-diff" ? {
      boundedInitialPrompts: promptBytes.length === 2 && promptBytes.every((bytes) => bytes <= maximumPromptBytes),
      completeCatalogReads: bothStages.every((stage) => completeCatalogRead(listings, stage)),
      boundedCatalogPages: listings.length > 0 && listings.every((page) => page.bytes <= maximumPageBytes),
      acceptedDeletedModuleDefect: state.findings.some((finding) => finding.jobId === jobId && finding.status === "posted" && finding.file === "src/assertAvailable.ts" &&
        /reserve|import|resolv|module/i.test(`${finding.title} ${finding.body}`)),
      completeScopedCounterReads: bothStages.every((stage) => completeScopedRead(reads, stage, "src/counter.ts")),
      completeScopedDeletionReads: bothStages.every((stage) => completeScopedRead(reads, stage, "src/assertAvailable.ts")),
      observedBothStageUsage: bothStages.every((stage) => state.usage.some((row) => row.jobId === jobId && row.stage === stage)),
      immutableAcceptedFindings: result?.success === true && ["src/counter.ts", "src/assertAvailable.ts"].every((file) =>
        result.data.findings.some((finding) => finding.file === file && finding.status === "pending")),
    } : {}),
  };
}

const selectProvider = (request: VerificationRequest) => request.live
  ? ReviewProviderLive(request.keys?.OPENROUTER_API_TOKEN ?? "unused")
  : FixtureProvider(request.scenario);

const observeStages = (observed: Observed) => Layer.effect(ReviewProvider, Effect.gen(function* () {
  const service = yield* ReviewProvider;
  return ReviewProvider.of({ run: (input) => Effect.suspend(() => {
    observed.promptBytes.push(Buffer.byteLength(input.prompt));
    return service.run({ ...input, diffCatalog: trackDiffReads(input.diffCatalog, input.stage, observed.reads, observed.listings) })
      .pipe(Effect.tap(() => Effect.sync(() => { observed.stages.push(input.stage); })));
  }) });
}));

export const recoverPrevious = (publications: Publications) => Effect.gen(function* () {
  const controller = yield* Controller;
  while (true) {
    const job = yield* controller.claim();
    if (!job) break;
    if (job.kind === "finding_command") {
      yield* runFindingCommand(job).pipe(Effect.provide(publications.layer(job._id)));
    } else if (job.resultJson === undefined) {
      yield* controller.forJob(job).interruptAnalysis("Previous local verification stopped before analysis completed");
    } else {
      yield* runJob(job).pipe(Effect.provide(Layer.mergeAll(FixtureGit, publications.layer(job.deliveryKey ?? job._id), NoProvider)));
    }
  }
  if ((yield* controller.ready()).length > 0) return yield* Effect.fail(new DevelopmentError({
    message: "Earlier work still holds a lease. Retry verification after its lease expires; inspect shows the expiry.",
  }));
});

const verifyReview = (request: VerificationRequest, backend: DevelopmentBackend, publications: Publications) => Effect.gen(function* () {
  const controller = yield* Controller;
  const runId = randomUUID();
  const observed: Observed = { stages: [], reads: [], listings: [], promptBytes: [] };
  const fixture = request.scenario === "large-diff" ? largeDiffFixture(fixtureContext) : { context: fixtureContext, git: FixtureGit };
  const jobId = yield* backend.enqueue(runId, { ...(request.model ? { model: request.model } : {}), ...(request.effort ? { effort: request.effort } : {}) });
  const job = yield* controller.claim();
  if (!job || job.kind !== "review" || job._id !== jobId) return yield* Effect.fail(new DevelopmentError({ message: "The local worker did not claim the expected fixture job" }));
  const services = Layer.mergeAll(fixture.git, publications.layer(runId, fixture.context), observeStages(observed).pipe(Layer.provide(selectProvider(request))));
  yield* runJob(job).pipe(Effect.provide(services));
  const state = yield* backend.inspect;
  const captured = publications.inspect().filter((row) => row.runId === runId);
  const assertions = assessVerification(state, jobId, request.scenario, captured, observed);
  const ownedBy = <T extends { jobId?: string | undefined }>(rows: T[]) => rows.filter((row) => row.jobId === jobId);
  return {
    runId, jobId, provider: job.provider, stageModels: job.stageModels,
    providerMode: request.live ? "OpenRouter API" : "OpenRouter SDK with synthetic HTTP responses", scenario: request.scenario,
    fixture: { changedFiles: fixture.context.fullDiff.length, fullDiffBytes: fixture.context.fullDiff.reduce((bytes, file) => bytes + Buffer.byteLength(file.diff), 0) },
    promptBytes: observed.promptBytes,
    catalogReads: observed.listings,
    diffReads: observed.reads.map(({ lines, ...read }) => ({ ...read, fragments: lines.length, bytes: lines.reduce((bytes, line) => bytes + Buffer.byteLength(line.text), 0) })),
    assertions, passed: Object.values(assertions).every(Boolean), publications: captured,
    job: state.jobs.find((row) => row._id === jobId), findings: ownedBy(state.findings), usage: ownedBy(state.usage),
    notes: ownedBy(state.notes), diagnostics: ownedBy(state.diagnostics), snapshots: ownedBy(state.snapshots),
  };
});

export const verify = (request: VerificationRequest, backend: DevelopmentBackend, publications: Publications, sourceHash: string) => Effect.gen(function* () {
  const controller = yield* Controller;
  yield* controller.waitOnline;
  yield* recoverPrevious(publications);
  const result = yield* verifyReview(request, backend, publications);
  return { sourceHash, passed: result.passed, coverage, result };
}).pipe(Effect.provide(ControllerLive), Effect.scoped);
