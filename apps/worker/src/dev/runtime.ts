import { secretValues } from "@fred/contracts";
import { mkdir } from "node:fs/promises";
import { Effect } from "effect";
import { WorkerConfig, readConfig } from "../config";
import { fixtureEnvironment, localConvexUrl } from "../fixtures";
import { connectBackend } from "./backend";
import { openPublications } from "./publications";
import { DevelopmentError, verificationRequest } from "./schema";
import { verify } from "./verification";

const captureDirectory = "/state";

export const developmentRuntime = (env: NodeJS.ProcessEnv) => Effect.gen(function* () {
  if (env.FRED_DEV_ONLY !== "1" || env.CONVEX_URL !== localConvexUrl ||
    !env.CONVEX_SELF_HOSTED_ADMIN_KEY || !env.WORKER_SECRET || !env.FRED_DEV_SOURCE_HASH) {
    return yield* Effect.fail(new DevelopmentError({ message: "Use pnpm fred dev up to configure the isolated local runtime" }));
  }
  const sourceHash = env.FRED_DEV_SOURCE_HASH;
  const config = yield* readConfig(fixtureEnvironment({
    WORKER_SECRET: env.WORKER_SECRET, CONVEX_SELF_HOSTED_ADMIN_KEY: env.CONVEX_SELF_HOSTED_ADMIN_KEY,
    WORKER_CONCURRENCY: "1", OPENROUTER_API_TOKEN: "synthetic",
  }));
  const backend = yield* connectBackend(config.CONVEX_URL, env.CONVEX_SELF_HOSTED_ADMIN_KEY);
  yield* backend.inspect;
  yield* Effect.tryPromise({ try: () => mkdir(captureDirectory, { recursive: true }), catch: () => new DevelopmentError({ message: "Cannot create local capture directory" }) });
  const publications = yield* openPublications(`${captureDirectory}/publications.jsonl`);
  let verifying = false;
  return {
    secret: env.WORKER_SECRET,
    health: () => ({ ready: true, sourceHash, verifying }),
    inspect: backend.inspect.pipe(Effect.map((state) => ({ sourceHash, verifying, ...state, publications: publications.inspect() }))),
    verify: (input: unknown) => Effect.gen(function* () {
      const parsed = verificationRequest.safeParse(input);
      if (!parsed.success) return yield* Effect.fail(new DevelopmentError({ message: "Invalid verification request or missing OpenRouter token" }));
      if (verifying) return yield* Effect.fail(new DevelopmentError({ message: "Verification already running in this worktree" }));
      return yield* Effect.acquireUseRelease(
        Effect.sync(() => { verifying = true; }),
        () => verify(parsed.data, backend, publications, sourceHash).pipe(Effect.provideService(WorkerConfig, {
          ...config, secrets: secretValues({}, [...config.secrets, ...Object.values(parsed.data.keys ?? {})]),
        })),
        () => Effect.sync(() => { verifying = false; }),
      );
    }),
  };
});

export type DevelopmentRuntime = Effect.Success<ReturnType<typeof developmentRuntime>>;
