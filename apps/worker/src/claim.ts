import { secretValues, type DiagnosticEvent, type DiagnosticFailure } from "@fred/contracts";
import { Effect } from "effect";
import { WorkerConfig } from "./config";
import { heartbeatInterval, type ClaimedWork } from "./controller";
import { classifyFailure } from "./diagnostics/failure";
import { failureLine, failureTrace, journalLine } from "./diagnostics/journal";
import { ConfigError, type ControllerError } from "./errors";
import type { MrScope } from "./gitlab";

type Outcome = "failed" | "interrupted";

// The values redacted from everything a claim writes: the worker's own secrets and the claim's project token.
export const claimSecrets = (claim: ClaimedWork) => WorkerConfig.useSync((config) => secretValues({}, [...config.secrets, claim.gitlabToken]));

// Identifies a claim in journal lines.
export const claimCorrelation = (claim: ClaimedWork) => {
  const shared = { gitlabProjectId: claim.gitlabProjectId, mrIid: claim.mrIid, provider: claim.provider, leaseGeneration: claim.leaseGeneration };
  return claim.kind === "review" ? { jobId: claim._id, ...shared, headSha: claim.headSha } : { commandId: claim._id, ...shared };
};

// The claim's MR, bound to its project token. Every bot user the project ever had counts as FRED.
const mrScope = (claim: ClaimedWork): MrScope => ({
  projectId: Number(claim.gitlabProjectId), mrIid: claim.mrIid, token: claim.gitlabToken,
  botUserIds: [...new Set([claim.gitlabBotUserId, ...claim.gitlabBotUserIds])].map(Number),
});

// Journals one failed or interrupted claim with its redacted trace and logs one line.
export const reportFailure = (claim: ClaimedWork, outcome: Outcome, error: unknown, failure: DiagnosticFailure, secrets: readonly string[], phase?: DiagnosticEvent["phase"]) => Effect.gen(function* () {
  journalLine({ fredFailure: 1, ...claimCorrelation(claim), at: Date.now(), outcome, ...(phase ? { phase } : {}), failure, trace: failureTrace(error, secrets) });
  const label = claim.kind === "review" ? `Review ${claim._id}` : `Finding command ${claim._id}`;
  yield* Effect.logWarning(`${label} ${outcome}${phase ? ` in ${phase}` : ""}: ${failureLine(failure)}`);
});

// Runs one claimed review or finding command. Fixture mode refuses other projects before any GitLab access. `work`
// receives the claim's MR scope and runs while the lease is renewed; whichever stops first decides. A failure is
// classified with `secrets`, handed to `failed`, which records it with the controller and names the outcome, then journaled.
export const runClaim = <E extends { readonly _tag: string }, R>(claim: ClaimedWork, options: {
  secrets: readonly string[];
  heartbeat: () => Effect.Effect<unknown, ControllerError>;
  work: (scope: MrScope) => Effect.Effect<void, E, R>;
  failed: (error: E | ConfigError | ControllerError, failure: DiagnosticFailure) => Effect.Effect<Outcome>;
  phase?: () => DiagnosticEvent["phase"];
}) => Effect.gen(function* () {
  const config = yield* WorkerConfig;
  const work: Effect.Effect<void, E | ConfigError, R> = config.WORKER_MODE === "fixture" && !config.WORKER_FIXTURE_PROJECT_IDS.includes(claim.gitlabProjectId)
    ? Effect.fail(new ConfigError({ message: "Fixture mode refuses a non-fixture GitLab project" }))
    : options.work(mrScope(claim));
  const heartbeat = options.heartbeat().pipe(Effect.andThen(Effect.sleep(heartbeatInterval)), Effect.forever);
  yield* Effect.raceFirst(work, heartbeat).pipe(Effect.catch((error) => Effect.gen(function* () {
    const failure = classifyFailure(error, options.secrets);
    const outcome = yield* options.failed(error, failure);
    yield* reportFailure(claim, outcome, error, failure, options.secrets, options.phase?.());
  })));
});
