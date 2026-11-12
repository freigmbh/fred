import { failureSummary, readReviewResult, stage1Output, stageModels, type DiagnosticEvent } from "@fred/contracts";
import { Cause, Effect, Exit, Fiber, Option } from "effect";
import type { z } from "zod";
import { claimCorrelation, claimSecrets, reportFailure, runClaim } from "./claim";
import { WorkerConfig } from "./config";
import { Controller, type ClaimedJob } from "./controller";
import { ConfigError, ParseError, Timeout, type WorkerError } from "./errors";
import { Git } from "./git";
import { GitLab, type GitLabReview } from "./gitlab";
import { readInstructions } from "./instructions";
import { ReviewProvider, type StageTranscript } from "./provider";
import { detectionPrompt, validationPrompt } from "./prompts";
import { makeDiffCatalog } from "./diffCatalog";
import { publishResult } from "./publish";
import { buildResult, validationSchema, validationToolSchema } from "./result";
import { openWorkspace } from "./sandbox/workspace";
import { makeUsage } from "./usage";
import { rulesSha, transcriptRecord } from "./transcript";
import { Diagnostics, makeDiagnosticRecorder } from "./diagnostics/recorder";
import { classifyFailure } from "./diagnostics/failure";
import { failureLine, journalLine } from "./diagnostics/journal";

export const stageDeadline = <A, E, R>(stage: Effect.Effect<A, E, R>) => stage.pipe(Effect.timeoutOrElse({
  duration: "45 minutes", orElse: () => Effect.fail(new Timeout({ message: "Review stage exceeded 45 minutes" })),
}));

// How a stage attempt ended, for its transcript. The stage deadline fails with Timeout instead of interrupting.
const attemptOutcome = (exit: Exit.Exit<unknown, { readonly _tag: string }>) => Exit.isSuccess(exit) ? "completed" as const
  : Cause.hasInterruptsOnly(exit.cause) ? "interrupted" as const
  : Option.exists(Cause.findErrorOption(exit.cause), (error) => error._tag === "Timeout") ? "timed_out" as const : "failed" as const;

// True when the controller still accepts writes for this job after `error`: a lost, disconnected, or timed-out
// controller cannot record the usage gap.
const controllerReachable = (error: WorkerError) => error._tag !== "ControllerError" || error.diagnostic?.controller?.reason === "rejected";

// Runs or resumes one claimed review with the claim's project token.
export const runJob = (job: ClaimedJob) => Effect.gen(function* () {
  const config = yield* WorkerConfig;
  const control = (yield* Controller).forJob(job);
  const git = yield* Git;
  const gitlabService = yield* GitLab;
  const provider = yield* ReviewProvider;
  const secrets = yield* claimSecrets(job);
  const release = config.FRED_RELEASE_SHA ? { release: config.FRED_RELEASE_SHA } : {};
  const correlation = claimCorrelation(job);
  const diagnostics = makeDiagnosticRecorder({
    leaseGeneration: job.leaseGeneration ?? 0, ...release,
    journal: (event) => journalLine({ fredDiagnostic: 1, ...correlation, event }),
    send: control.recordDiagnostics,
  });
  const snapshotJson = () => JSON.stringify(diagnostics.snapshot());
  const writer = yield* Effect.forkScoped(diagnostics.writer);
  // Stores a collecting job's stage transcript at stage exit, before the outer handlers report a failure, while the lease holds.
  // Best-effort and bounded: build, gzip, and store share one interruptible 30-second deadline, and any failure or defect becomes
  // one warning while the stage's own exit stands. A stage that never reached the provider has no live transcript and stores nothing.
  const captureTranscript = (live: StageTranscript | undefined, attempt: Parameters<typeof transcriptRecord>[1]) => live === undefined ? Effect.void
    : transcriptRecord(job, attempt, live, secrets).pipe(
        Effect.flatMap(control.storeTranscript),
        Effect.interruptible,
        Effect.timeoutOrElse({ duration: "30 seconds", orElse: () => Effect.fail(new Timeout({ message: "Transcript capture exceeded 30 seconds" })) }),
        Effect.catchCause((cause) => Effect.logWarning(`Transcript of review ${job._id} ${attempt.stage} not stored: ${failureLine(classifyFailure(Cause.squash(cause), secrets))}`)),
      );
  // Brackets a phase with diagnostic events. A stage passes its selection so every later event names the model that ran.
  const tracked = <A, E, R>(phase: DiagnosticEvent["phase"], operation: Effect.Effect<A, E, R>, selection?: { model: string; effort: NonNullable<DiagnosticEvent["effort"]> }) => Effect.gen(function* () {
    const started = Date.now();
    diagnostics.emit({ kind: "phase_started", phase, ...(selection ?? {}) });
    const value = yield* operation;
    diagnostics.emit({ kind: "phase_completed", phase, durationMs: Date.now() - started });
    return value;
  });

  const resume = (gitlab: GitLabReview, stored: string) => tracked("publish", Effect.gen(function* () {
    const result = yield* Effect.try({ try: () => readReviewResult(JSON.parse(stored)), catch: (cause) => new ParseError({ message: "Stored publication result is invalid", cause }) });
    yield* publishResult(job, result, control, gitlab);
  }));

  const analyse = (gitlab: GitLabReview, botUserIds: number[]) => Effect.gen(function* () {
    const prepared = yield* tracked("context", Effect.gen(function* () {
      const context = yield* gitlab.loadContext();
      if (context === undefined) return undefined;
      const selections = yield* Effect.try({
        try: () => stageModels.parse(job.stageModels),
        catch: (cause) => new ConfigError({ message: "Unsupported review model or effort selection", cause }),
      });
      yield* gitlab.ensureLabels();
      return { context, selections };
    }));
    if (prepared === undefined) { yield* control.supersede(); return; }
    const { context, selections } = prepared;
    const contextHints = [...context.hints];
    if (context.unchangedSinceBaseline) {
      if ((yield* control.skip()).skipped) return;
      contextHints.push("No changes since the previous review; earlier findings are validated again because a review that posted some of them did not complete.");
    }
    const checkout = yield* tracked("checkout", git.checkout({ url: context.cloneUrl, sha: job.headSha, token: job.gitlabToken }).pipe(Effect.timeoutOrElse({
      duration: "5 minutes", orElse: () => Effect.fail(new Timeout({ message: "Checkout exceeded five minutes" })),
    })));
    const { workspace, instructions } = yield* tracked("instructions", Effect.gen(function* () {
      const workspace = yield* openWorkspace(checkout.path);
      return { workspace, instructions: yield* readInstructions(workspace.filesystem) };
    }));
    const previous = yield* control.previousFindings();
    const diffCatalog = makeDiffCatalog(context);
    const promptInput = { context, botUserIds, instructions, skills: workspace.skills.entries, previous, diffCatalog };
    const prompted = { reviewRulesSha: rulesSha(instructions.review), ...release, ...(config.FRED_VERSION ? { fredVersion: config.FRED_VERSION } : {}) };
    const runStage = <A>(stage: "detect" | "validate", renderPrompt: ReturnType<typeof detectionPrompt>, schema: z.ZodType<A>, toolSchema: z.ZodType) => Effect.gen(function* () {
      const { model, effort } = selections[stage];
      const usage = yield* makeUsage(job, control, stage, model);
      let live: StageTranscript | undefined;
      const outcome = yield* tracked(stage, stageDeadline(Effect.gen(function* () {
        const prompt = yield* renderPrompt;
        const result = yield* provider.run({
          stage, workspace, diffCatalog, prompt: prompt.text, model, effort, schema, toolSchema, secrets,
          onUsage: (snapshot) => usage.observe(snapshot),
          ...(job.collectTranscripts ? { onTranscript: (transcript: StageTranscript) => { live = transcript; } } : {}),
        });
        return { ...result, hints: [...prompt.hints, ...result.hints] };
      }).pipe(Effect.tapErrorTag("ProviderError", (error) => Effect.sync(() => {
        diagnostics.emit({ kind: "failed", phase: stage, failure: classifyFailure(error, secrets) });
      })))), { model, effort }).pipe(
        Effect.onExit((exit) => captureTranscript(live, { stage, model, effort, outcome: attemptOutcome(exit), ...prompted })),
        Effect.tapError((error) => controllerReachable(error) ? usage.finish().pipe(Effect.ignore) : Effect.void),
      );
      const ledgerConfirmed = yield* usage.finish();
      return { ...outcome, usageConfirmed: ledgerConfirmed && outcome.usageConfirmed };
    });
    const detection = yield* runStage("detect", detectionPrompt(promptInput), stage1Output, stage1Output);
    const validation = yield* runStage("validate", validationPrompt(promptInput, detection.output.candidates), validationSchema(detection.output.candidates, previous), validationToolSchema);
    const hints = [...instructions.hints, ...contextHints, ...detection.hints, ...validation.hints];
    if (!detection.usageConfirmed || !validation.usageConfirmed) {
      hints.push("Usage accounting is incomplete for this review; recorded spend may be below the provider bill.");
      yield* control.markUsageIncomplete("Final provider usage was not confirmed");
    }
    const result = yield* buildResult({ jobId: job._id, candidates: detection.output.candidates, validation: validation.output, previous, context, botUserIds, hints, fredVersion: config.FRED_VERSION });
    yield* tracked("save", control.saveResult(JSON.stringify(result)));
    yield* tracked("publish", publishResult(job, result, control, gitlab));
  });

  yield* runClaim(job, {
    secrets,
    heartbeat: control.heartbeat,
    phase: () => diagnostics.snapshot().phase,
    work: (scope) => {
      const gitlab = gitlabService.forReview({ ...scope, headSha: job.headSha, previousReviewedSha: job.previousReviewedSha });
      return (job.resultJson === undefined ? analyse(gitlab, scope.botUserIds) : resume(gitlab, job.resultJson))
        .pipe(Effect.scoped, Effect.provideService(Diagnostics, diagnostics));
    },
    // A lost controller interrupts analysis instead of failing it, so the review can be requested again.
    failed: (error, failure) => Effect.gen(function* () {
      if (error._tag === "ControllerError") {
        diagnostics.emit({ kind: "interrupted", failure, reason: "controller_unavailable" });
        if (failure.controller?.reason === "rejected") yield* control.fail("error", failureSummary(failure), snapshotJson()).pipe(Effect.ignore);
        else if (failure.controller?.reason !== "lease_lost") yield* control.interruptAnalysis(failureSummary(failure), snapshotJson()).pipe(Effect.ignore);
        return "interrupted" as const;
      }
      if (error._tag !== "ProviderError" || diagnostics.snapshot().failure === undefined) diagnostics.emit({ kind: "failed", failure });
      const reason = error._tag === "Timeout" ? "timeout" : error._tag === "LabelMissing" ? "label_missing" : "error";
      yield* control.fail(reason, failureSummary(failure), snapshotJson()).pipe(Effect.catch(() => Effect.sync(() => {
        diagnostics.emit({ kind: "diagnostics_dropped", reason: "controller_unavailable" });
      })));
      return "failed" as const;
    }),
  }).pipe(
    Effect.catchDefect((cause) => Effect.gen(function* () {
      const failure = classifyFailure(cause, secrets);
      diagnostics.emit({ kind: "failed", failure });
      yield* reportFailure(job, "failed", cause, failure, secrets, diagnostics.snapshot().phase);
      yield* control.interruptAnalysis("Unexpected worker failure; usage may be incomplete", snapshotJson()).pipe(Effect.ignore);
    })),
    Effect.onInterrupt(() => Effect.gen(function* () {
      diagnostics.emit({ kind: "interrupted", reason: "worker_stopped" });
      yield* control.interruptAnalysis("Worker stopped during analysis; usage may be incomplete", snapshotJson()).pipe(Effect.ignore);
    })),
    Effect.ensuring(Effect.gen(function* () {
      yield* Fiber.interrupt(writer);
      yield* diagnostics.finish;
    })),
  );
}).pipe(Effect.scoped);
