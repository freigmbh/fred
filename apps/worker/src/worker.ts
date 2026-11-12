import { Effect, Queue } from "effect";
import { WorkerConfig } from "./config";
import { Controller, type QueueState } from "./controller";
import { runFindingCommand } from "./runFindingCommand";
import { runJob } from "./runJob";
import { classifyFailure } from "./diagnostics/failure";
import { failureLine } from "./diagnostics/journal";

// Tells a queue update with work for `jobs.claim` apart from a heartbeat that only renewed a lease.
// Queued reviews and commands are claimable; an expired lease is reclaimable publication or command work, or analysis that claim expires.
export const hasClaimableWork = (jobs: readonly Pick<QueueState[number], "status" | "leaseExpiresAt">[], now: number) =>
  jobs.some((job) => job.status === "queued" || (job.leaseExpiresAt ?? 0) <= now);

// Subscription changes with claimable work, completed jobs, reconnects, and lease expiry wake the bounded claim loop.
export const worker = (shutdown: AbortSignal) => Effect.gen(function* () {
  const config = yield* WorkerConfig;
  const controller = yield* Controller;
  const wake = yield* Queue.make<void>({ capacity: 1, strategy: "dropping" });
  const active = new Set<string>();
  yield* Effect.acquireRelease(Effect.sync(() => {
    const wakeForShutdown = () => { Queue.offerUnsafe(wake, undefined); };
    shutdown.addEventListener("abort", wakeForShutdown);
    return () => shutdown.removeEventListener("abort", wakeForShutdown);
  }), (remove) => Effect.sync(remove));
  let leaseWake: ReturnType<typeof setTimeout> | undefined;
  yield* Effect.acquireRelease(controller.watch((jobs) => {
    // One clock reading for the gate and the timer, so every lease either wakes now or keeps a scheduled wake.
    const now = Date.now();
    if (!jobs || hasClaimableWork(jobs, now)) Queue.offerUnsafe(wake, undefined);
    if (!jobs) return;
    if (leaseWake) clearTimeout(leaseWake);
    const expires = jobs.flatMap((job) => job.leaseExpiresAt === undefined ? [] : [job.leaseExpiresAt]).filter((time) => time > now);
    if (expires.length) leaseWake = setTimeout(() => Queue.offerUnsafe(wake, undefined), Math.max(1, Math.min(...expires) - now + 100));
  }), (unsubscribe) => Effect.sync(() => { unsubscribe(); if (leaseWake) clearTimeout(leaseWake); }));
  yield* controller.waitOnline;
  yield* controller.ready();
  yield* Queue.offer(wake, undefined);
  yield* Effect.logInfo("FRED worker connected and waiting for reviews");
  while (!shutdown.aborted || active.size > 0) {
    yield* Queue.take(wake);
    if (shutdown.aborted) continue;
    if (!(yield* controller.isConnected)) continue;
    while (!shutdown.aborted && active.size < config.WORKER_CONCURRENCY && (yield* controller.isConnected)) {
      const job = yield* controller.claim().pipe(Effect.catch((error) => Effect.gen(function* () {
        yield* Effect.logWarning(`Controller claim failed; retrying after reconnect window: ${failureLine(classifyFailure(error, config.secrets))}`);
        yield* Effect.sleep("10 seconds");
        yield* Queue.offer(wake, undefined);
        return null;
      })));
      if (!job) break;
      active.add(job._id);
      yield* Effect.forkScoped((job.kind === "finding_command" ? runFindingCommand(job) : runJob(job)).pipe(Effect.onExit(() => Effect.sync(() => {
        active.delete(job._id);
        Queue.offerUnsafe(wake, undefined);
      }))));
    }
  }
});
