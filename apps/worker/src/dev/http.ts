import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Cause, Effect, Exit } from "effect";
import type { ControllerError } from "../errors";
import type { DevelopmentRuntime } from "./runtime";
import { DevelopmentError, developmentPort, readBounded } from "./schema";

const requestLimit = 16384;

const reply = (response: ServerResponse, status: number, value: unknown) => {
  if (response.destroyed) return;
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
};

const authorized = (request: IncomingMessage, secret: string) => {
  const authorization = request.headers.authorization;
  const expected = `Bearer ${secret}`;
  return !request.headers.origin && authorization !== undefined && Buffer.byteLength(authorization) === Buffer.byteLength(expected) &&
    timingSafeEqual(Buffer.from(authorization), Buffer.from(expected));
};

const readBody = (request: IncomingMessage) => Effect.tryPromise({
  try: async (): Promise<unknown> => JSON.parse(await readBounded(request, requestLimit)),
  catch: () => new DevelopmentError({ message: "Invalid verification request body" }),
});

const route = (runtime: DevelopmentRuntime, request: IncomingMessage): Effect.Effect<unknown, DevelopmentError | ControllerError> => {
  if (request.method === "GET" && request.url === "/inspect") return runtime.inspect;
  if (request.method === "POST" && request.url === "/verify") return readBody(request).pipe(Effect.flatMap(runtime.verify));
  return Effect.fail(new DevelopmentError({ message: "Unknown local development endpoint" }));
};

export const serve = (runtime: DevelopmentRuntime) => Effect.acquireRelease(
  Effect.tryPromise({
    try: () => new Promise<{ server: ReturnType<typeof createServer>; active: Map<AbortController, Promise<void>> }>((resolve, reject) => {
      const active = new Map<AbortController, Promise<void>>();
      const server = createServer((request, response) => {
        if (request.method === "GET" && request.url === "/health") { reply(response, 200, runtime.health()); return; }
        if (!authorized(request, runtime.secret)) { reply(response, 403, { error: "Local development authentication required" }); return; }
        const abort = new AbortController();
        const stop = () => { if (!response.writableEnded) abort.abort(); };
        response.once("close", stop);
        const completion = Effect.runPromiseExit(route(runtime, request), { signal: abort.signal }).then((exit) => {
          active.delete(abort);
          response.removeListener("close", stop);
          if (Exit.isSuccess(exit)) { reply(response, 200, exit.value); return; }
          const error = Cause.squash(exit.cause);
          reply(response, 400, { error: error instanceof DevelopmentError ? error.message : "Local verification failed; inspect diagnostics" });
        });
        active.set(abort, completion);
      });
      server.once("error", reject);
      server.listen(developmentPort, "127.0.0.1", () => { server.removeListener("error", reject); resolve({ server, active }); });
    }),
    catch: () => new DevelopmentError({ message: "Cannot start local development HTTP service" }),
  }),
  ({ server, active }) => Effect.promise(async () => {
    for (const request of active.keys()) request.abort();
    server.closeAllConnections();
    await Promise.all(active.values());
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }),
);
