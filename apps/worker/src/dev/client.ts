import { request as httpRequest } from "node:http";
import { parseArgs } from "node:util";
import { Effect } from "effect";
import { DevelopmentError, developmentEndpoint, readBounded, verificationRequest } from "./schema";

const usage = "Use inspect or verify [--live openrouter] [--model vendor/model] [--effort effort] [--scenario success|provider-failure|large-diff]";

const readKeys = Effect.tryPromise({
  try: () => readBounded(process.stdin, 16384).then((body): unknown => JSON.parse(body)),
  catch: () => new DevelopmentError({ message: "Provide the OpenRouter token as JSON on stdin" }),
});

const call = (action: "inspect" | "verify", body: unknown) => Effect.tryPromise({
  try: (signal) => new Promise<{ ok: boolean; result: unknown }>((resolve, reject) => {
    const request = httpRequest(`${developmentEndpoint}/${action}`, {
      method: action === "verify" ? "POST" : "GET", signal, agent: false,
      headers: { Authorization: `Bearer ${process.env.WORKER_SECRET}`, "Content-Type": "application/json" },
    }, (response) => {
      const ok = response.statusCode !== undefined && response.statusCode >= 200 && response.statusCode < 300;
      readBounded(response, 16 * 1024 * 1024).then((text) => ({ ok, result: JSON.parse(text) as unknown })).then(resolve, reject);
    });
    request.once("error", reject);
    request.end(action === "verify" ? JSON.stringify(body) : undefined);
  }),
  catch: () => new DevelopmentError({ message: "Local development request failed" }),
});

const command = Effect.gen(function* () {
  const parsed = yield* Effect.try({
    try: () => parseArgs({ allowPositionals: true, options: { live: { type: "string" }, model: { type: "string" }, effort: { type: "string" }, scenario: { type: "string" } } }),
    catch: () => new DevelopmentError({ message: usage }),
  });
  const action = parsed.positionals[0];
  if (parsed.positionals.length !== 1 || (action !== "inspect" && action !== "verify") || !process.env.WORKER_SECRET) {
    return yield* Effect.fail(new DevelopmentError({ message: "Use the local development CLI to inspect or verify" }));
  }
  let body: unknown = {};
  if (action === "verify") {
    const live = parsed.values.live;
    const keys = live ? yield* readKeys : undefined;
    const request = verificationRequest.safeParse({ ...parsed.values, ...(keys ? { keys } : {}) });
    if (!request.success) return yield* Effect.fail(new DevelopmentError({ message: "Invalid verification options or missing OpenRouter token" }));
    body = request.data;
  }
  const response = yield* call(action, body);
  process.stdout.write(`${JSON.stringify(response.result)}\n`);
  const failed = typeof response.result === "object" && response.result !== null && "passed" in response.result && response.result.passed === false;
  if (!response.ok || failed) process.exitCode = 1;
});

const shutdown = new AbortController();
const stop = () => shutdown.abort();
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
await Effect.runPromise(command.pipe(Effect.catch((error) => Effect.sync(() => {
  process.stderr.write(`${error.message}\n`); process.exitCode = 1;
}))), { signal: shutdown.signal }).catch(() => { process.exitCode = 1; });
process.removeListener("SIGTERM", stop);
process.removeListener("SIGINT", stop);
