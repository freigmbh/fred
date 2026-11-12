import { Effect, Layer } from "effect";
import type { Id } from "../../controller/convex/_generated/dataModel";
import fixture from "../../../fixtures/reviews/basic.json";
import { WorkerConfig, readConfig } from "./config";
import { Controller, type ClaimedJob, type JobControl } from "./controller";
import { ControllerError } from "./errors";
import { FixtureGit, fixtureContext, fixtureEnvironment, fixtureProjectId } from "./fixtures";
import { GitLab, type GitLabReview } from "./gitlab";
import { ReviewProvider } from "./provider";

export const fixtureJob: ClaimedJob = {
  kind: "review", _id: "fixture-job" as Id<"reviewJobs">, _creationTime: 1,
  projectId: "fixture-project" as Id<"projects">, developerId: "fixture-developer" as Id<"developers">,
  mrIid: 1, headSha: fixtureContext.diffRefs.head_sha, provider: "fred", status: "running", triggeredBy: "fixture-user",
  leaseToken: "fixture-lease", leaseExpiresAt: 200_000, leaseGeneration: 1, workerId: "fixture-worker",
  gitlabProjectId: fixtureProjectId, projectPath: "fixtures/example", gitlabUserId: "2", gitlabBotUserId: "3", gitlabBotUserIds: ["3"], gitlabToken: "fixture-token",
  stageModels: { detect: { model: "openai/gpt-6-astra", effort: "medium" }, validate: { model: "openai/gpt-6-astra", effort: "medium" } },
  publicationAcks: [],
};

export const fixtureConfig = Layer.effect(WorkerConfig, readConfig(fixtureEnvironment()));

// Serves one fake GitLab for every claim, review or finding command.
export const gitlabLayer = (gitlab: GitLabReview) => Layer.succeed(GitLab, { forMr: () => gitlab, forReview: () => gitlab });

// Fake services for one review. `calls` records every controller write, GitLab write, and stage in order.
export const testServices = () => {
  const calls: string[] = [];
  let saved: string | undefined;
  const control = {
    heartbeat: () => Effect.succeed({ leaseExpiresAt: 200_000, publicationCurrent: true }),
    previousFindings: () => Effect.succeed([]),
    saveResult: (json: string) => Effect.sync(() => { saved = json; calls.push("save"); return null; }),
    acknowledge: (key: string) => Effect.sync(() => { calls.push(`ack:${key}`); return null; }),
    complete: () => Effect.sync(() => { calls.push("complete"); return null; }),
    supersede: () => Effect.sync(() => { calls.push("supersede"); return null; }),
    skip: () => Effect.sync(() => { calls.push("skip"); return { skipped: true }; }),
    fail: () => Effect.sync(() => { calls.push("fail"); return null; }),
    recordDiagnostics: () => Effect.succeed(null),
    interruptAnalysis: () => Effect.sync(() => { calls.push("interruptAnalysis"); return null; }),
    recordUsage: () => Effect.sync(() => { calls.push("usage"); return "fixture-usage" as Id<"usageEvents">; }),
    confirmUsage: () => Effect.sync(() => { calls.push("confirmUsage"); return null; }),
    markUsageIncomplete: () => Effect.sync(() => { calls.push("incompleteUsage"); return null; }),
    storeTranscript: () => Effect.sync(() => { calls.push("transcript"); return null; }),
  } satisfies JobControl;
  const controller = Controller.of({
    forJob: () => control,
    forCommand: () => {
      const unexpected = () => Effect.fail(new ControllerError({ message: "Finding commands are not configured in review test services" }));
      return { heartbeat: unexpected, context: unexpected, reconcileSummary: unexpected, prepare: unexpected, acknowledge: unexpected, fail: unexpected };
    },
    isConnected: Effect.succeed(true), waitOnline: Effect.void,
    ready: () => Effect.succeed([]), claim: () => Effect.succeed(null), watch: () => Effect.succeed(() => {}),
  });
  const gitlab = {
    loadContext: () => Effect.succeed<typeof fixtureContext | undefined>(fixtureContext), isCurrent: () => Effect.succeed(true), ensureLabels: () => Effect.void,
    publishDiscussion: () => Effect.sync(() => { calls.push("inline"); return { discussionId: "discussion-1", noteId: "note-2" }; }),
    publishSummary: () => Effect.sync(() => { calls.push("summary"); return { noteId: "note-1" }; }),
    findSummary: () => Effect.succeed<{ noteId: string } | undefined>(undefined),
    resolveDiscussion: () => Effect.sync(() => { calls.push("resolve"); }),
    setLabel: () => Effect.sync(() => { calls.push("label"); }),
  } satisfies GitLabReview;
  const provider = ReviewProvider.of({ run: (input) => Effect.gen(function* () {
    calls.push(input.stage);
    yield* input.onUsage({ inputTokens: 100, cachedInputTokens: 0, outputTokens: 10, cacheCreationInputTokens: 0, costUsd: 0.001, final: true });
    return { output: input.schema.parse(fixture[input.stage]), usageConfirmed: true, hints: [] };
  }) });
  const layers = Layer.mergeAll(fixtureConfig, Layer.succeed(Controller, controller), gitlabLayer(gitlab), Layer.succeed(ReviewProvider, provider), FixtureGit);
  return { calls, control, controller, gitlab, provider, layers, saved: () => saved };
};
