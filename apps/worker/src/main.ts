import { Cause, Effect, Exit, Layer } from "effect";
import { failureSummary, secretValues } from "@fred/contracts";
import { WorkerConfig, WorkerConfigLive } from "./config";
import { ControllerLive } from "./controller";
import { GitLive } from "./git";
import { GitLabLive } from "./gitlab";
import { ReviewProviderLive } from "./providers/openrouter";
import { worker } from "./worker";
import { classifyFailure } from "./diagnostics/failure";
import { failureTrace } from "./diagnostics/journal";

const shutdown = new AbortController();
const program = Effect.gen(function* () {
  const config = yield* WorkerConfig;
  yield* Effect.logInfo(JSON.stringify({ fredRuntime: 1, release: config.FRED_RELEASE_SHA ?? "unknown", version: config.FRED_VERSION ?? "unknown", runtime: "openrouter" }));
  const services = Layer.mergeAll(
    ControllerLive,
    GitLive({ baseUrl: config.GITLAB_URL }),
    GitLabLive({ baseUrl: config.GITLAB_URL }),
    ReviewProviderLive(config.OPENROUTER_API_TOKEN),
  );
  yield* worker(shutdown.signal).pipe(Effect.provide(services));
}).pipe(Effect.provide(WorkerConfigLive), Effect.tapErrorTag("ConfigError", (error) => Effect.logError(error.message)), Effect.scoped);

const fiber = Effect.runFork(program);
const stop = () => { shutdown.abort(); };
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
fiber.addObserver((exit) => {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  if (Exit.isSuccess(exit)) return;
  const error = Cause.squash(exit.cause);
  // The configuration may be what failed, so the environment's secrets are read here directly.
  const secrets = secretValues(process.env);
  const failure = classifyFailure(error, secrets);
  if (!Exit.hasInterrupts(exit)) {
    process.stderr.write(`${JSON.stringify({ fredRuntimeFailure: 1, at: Date.now(), failure, trace: failureTrace(error, secrets) })}\n`);
    process.stderr.write(`FRED worker stopped: ${failureSummary(failure)}.\n`);
    process.exitCode = 1;
  }
});
