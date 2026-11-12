import { Deferred, Effect, Fiber, Layer } from "effect";
import { expect, it } from "vitest";
import { Controller } from "./controller";
import { ReviewProvider } from "./provider";
import { fixtureJob, testServices } from "./testLayers";
import { hasClaimableWork, worker } from "./worker";

it("finishes an active review without claiming another job after shutdown", async () => {
  const test = testServices();
  const shutdown = new AbortController();
  let claims = 0;
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const provider = ReviewProvider.of({ run: (input) => Effect.gen(function* () {
      yield* Deferred.succeed(started, undefined);
      yield* Deferred.await(release);
      return yield* test.provider.run(input);
    }) });
    const controller = Controller.of({ ...test.controller, claim: () => Effect.sync(() => {
      claims++;
      return claims === 1 ? fixtureJob : null;
    }) });
    const fiber = yield* Effect.forkScoped(worker(shutdown.signal).pipe(
      Effect.provide(Layer.mergeAll(Layer.succeed(Controller, controller), Layer.succeed(ReviewProvider, provider))),
      Effect.provide(test.layers),
    ));
    yield* Deferred.await(started);
    const claimsBeforeShutdown = claims;
    shutdown.abort();
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(fiber);
    expect(claims).toBe(claimsBeforeShutdown);
  })));
  expect(test.calls).toContain("complete");
  expect(test.calls).not.toContain("interruptAnalysis");
});

it("claims for queued work and expired leases but not for a renewed lease", () => {
  const now = 1_000_000;
  expect(hasClaimableWork([{ status: "running", leaseExpiresAt: now + 120_000 }, { status: "publishing", leaseExpiresAt: now + 5_000 }], now)).toBe(false);
  expect(hasClaimableWork([{ status: "running", leaseExpiresAt: now + 120_000 }, { status: "queued", leaseExpiresAt: undefined }], now)).toBe(true);
  expect(hasClaimableWork([{ status: "publishing", leaseExpiresAt: now }], now)).toBe(true);
  expect(hasClaimableWork([{ status: "running", leaseExpiresAt: now - 1 }], now)).toBe(true);
});
