import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Layer, type Scope } from "effect";
import { plainHttpUrl } from "../config";
import { CloneError } from "../errors";

type Checkout = { url: string; sha: string; token: string };
type GitOptions = { baseUrl: string; executable?: string; temporaryRoot?: string };
type Completion = { code: number | null; signal: NodeJS.Signals | null; output: string; errors: string; spawnError?: Error };
type Running = { process: ChildProcess; completion: Promise<Completion> };

const appendBounded = (text: string, chunk: Buffer, limit: number) => text.length < limit ? text + chunk.toString("utf8").slice(0, limit - text.length) : text;

const start = (executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) => Effect.try({
  try: (): Running => {
    const child = spawn(executable, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let errors = "";
    child.stdout?.on("data", (chunk: Buffer) => { output = appendBounded(output, chunk, 1024); });
    child.stderr?.on("data", (chunk: Buffer) => { errors = appendBounded(errors, chunk, 65_536); });
    const completion = new Promise<Completion>((resolve) => {
      child.once("error", (spawnError) => resolve({ code: null, signal: null, output: "", errors, spawnError }));
      child.once("close", (code, signal) => resolve({ code, signal, output, errors }));
    });
    return { process: child, completion };
  },
  catch: (cause) => new CloneError({ message: "Could not start git", cause }),
});

// The scoped finalizer kills an interrupted child and waits for exit before deleting its checkout.
const run = (executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) => Effect.scoped(Effect.gen(function* () {
  const child = yield* Effect.acquireRelease(start(executable, args, cwd, env), (running) => Effect.promise(async () => {
    if (running.process.pid !== undefined) {
      try { process.kill(-running.process.pid, "SIGKILL"); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
    }
    await running.completion;
  }));
  const result = yield* Effect.tryPromise({ try: () => child.completion, catch: (cause) => new CloneError({ message: "Git process failed", cause }) });
  if (result.code !== 0) {
    const status = result.spawnError ? `could not start: ${result.spawnError.message}` : result.signal ? `signal ${result.signal}` : `exit ${result.code}`;
    const command = args.find((arg, index) => !arg.startsWith("-") && args[index - 1] !== "-c") ?? args[0];
    return yield* Effect.fail(new CloneError({ message: `Git ${command} failed (${status})`, ...(result.errors.trim() ? { stderr: result.errors } : {}) }));
  }
  return result.output.trim();
}));

// Auth stays in the subprocess environment; hooks, helpers, redirects, and non-HTTP transports are disabled.
const gitEnvironment = (token: string): NodeJS.ProcessEnv => {
  const config = [
    ["http.extraHeader", `Authorization: Basic ${Buffer.from(`oauth2:${token}`).toString("base64")}`],
    ["http.followRedirects", "false"], ["credential.helper", ""], ["core.hooksPath", "/dev/null"],
    ["protocol.allow", "never"], ["protocol.https.allow", "always"], ["protocol.http.allow", "always"],
    ["filter.lfs.required", "false"], ["filter.lfs.smudge", ""], ["filter.lfs.process", ""],
  ];
  return {
    PATH: "/usr/bin:/bin:/usr/local/bin", LANG: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/usr/bin/false", GIT_CONFIG_COUNT: String(config.length),
    ...Object.fromEntries(config.flatMap(([key, value], index) => [[`GIT_CONFIG_KEY_${index}`, key], [`GIT_CONFIG_VALUE_${index}`, value]])),
  };
};

export const makeGit = ({ baseUrl, executable = "/usr/bin/git", temporaryRoot = tmpdir() }: GitOptions) => ({
  checkout: ({ url, sha, token }: Checkout) => Effect.gen(function* () {
    if (!plainHttpUrl(url, baseUrl) || !/^[a-fA-F0-9]{40,64}$/.test(sha)) {
      return yield* new CloneError({ message: "Checkout requires a full commit SHA and the configured GitLab origin" });
    }
    const path = yield* Effect.acquireRelease(
      Effect.tryPromise({ try: () => mkdtemp(join(temporaryRoot, "fred-review-")), catch: () => new CloneError({ message: "Could not create review checkout" }) }),
      (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
    );
    const env = gitEnvironment(token);
    yield* run(executable, ["init", "--quiet", "--template="], path, env);
    yield* run(executable, ["fetch", "--quiet", "--depth=1", "--no-tags", "--no-recurse-submodules", url, sha], path, env);
    yield* run(executable, ["-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", "FETCH_HEAD"], path, env);
    const actual = yield* run(executable, ["rev-parse", "HEAD"], path, env);
    if (actual.toLowerCase() !== sha.toLowerCase()) return yield* Effect.fail(new CloneError({ message: "Checkout commit does not match the claimed SHA" }));
    yield* Effect.tryPromise({ try: () => rm(join(path, ".git"), { recursive: true, force: true }), catch: () => new CloneError({ message: "Could not remove checkout metadata" }) });
    return { path };
  }),
});

export class Git extends Context.Service<Git, { checkout: (input: Checkout) => Effect.Effect<{ path: string }, CloneError, Scope.Scope> }>()("fred/Git") {}
export const GitLive = (options: GitOptions) => Layer.succeed(Git, makeGit(options));
