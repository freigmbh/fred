import { Cause, Effect, Exit } from "effect";
import { serve } from "./http";
import { developmentRuntime } from "./runtime";
import { DevelopmentError } from "./schema";

const shutdown = new AbortController();
const stop = () => shutdown.abort();
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
const exit = await Effect.runPromiseExit(Effect.gen(function* () {
  const runtime = yield* developmentRuntime(process.env);
  yield* serve(runtime);
  process.stdout.write(`${JSON.stringify({ localDevelopment: "ready", ...runtime.health() })}\n`);
  yield* Effect.never;
}).pipe(Effect.scoped), { signal: shutdown.signal });
process.removeListener("SIGTERM", stop);
process.removeListener("SIGINT", stop);
if (Exit.isFailure(exit)) {
  const error = Cause.squash(exit.cause);
  if (!Exit.hasInterrupts(exit)) {
    process.stderr.write(`${error instanceof DevelopmentError ? error.message : "Local development runtime failed"}\n`);
    process.exitCode = 1;
  }
}
