import { createHash } from "node:crypto";
import { Effect, Semaphore } from "effect";
import type { ClaimedJob, JobControl } from "./controller";
import { usageSnapshot, type UsageSnapshot } from "./provider";
import { ParseError } from "./errors";


const tokenCounts = (sample: UsageSnapshot) => ({
  inputTokens: sample.inputTokens, cachedInputTokens: sample.cachedInputTokens,
  outputTokens: sample.outputTokens, cacheCreationInputTokens: sample.cacheCreationInputTokens,
});

// Serializes cumulative observations and advances the baseline only after the ledger acknowledges them.
// Unpriced requests skip their usage row and advance only token counters, preserving the next priced delta.
export const makeUsage = (job: ClaimedJob, controller: JobControl, stage: "detect" | "validate", model: string) => Effect.gen(function* () {
  const semaphore = yield* Semaphore.make(1);
  let previous = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, costUsd: 0 };
  let complete = false;
  let gap = false;
  const observe = (observation: UsageSnapshot) => Semaphore.withPermits(semaphore, 1)(Effect.gen(function* () {
    const sample = yield* Effect.try({ try: () => usageSnapshot.parse(observation), catch: (cause) => new ParseError({ message: "Invalid provider usage", cause }) });
    if (sample.costUsd === undefined) {
      gap = true;
      yield* controller.markUsageIncomplete("OpenRouter did not report the request cost");
      previous = { ...previous, ...tokenCounts(sample) };
      return;
    }
    const current = { ...tokenCounts(sample), costUsd: sample.costUsd };
    if (Object.entries(current).some(([key, value]) => value < previous[key as keyof typeof previous] - 1e-9)) {
      gap = true;
      yield* controller.markUsageIncomplete("Provider usage counters decreased or reset");
      return;
    }
    const delta = {
      inputTokens: current.inputTokens - previous.inputTokens + current.cacheCreationInputTokens - previous.cacheCreationInputTokens,
      cachedInputTokens: current.cachedInputTokens - previous.cachedInputTokens,
      outputTokens: current.outputTokens - previous.outputTokens,
      costUsd: Math.max(0, current.costUsd - previous.costUsd),
    };
    if (Object.values(delta).some((value) => value > 0)) {
      const eventKey = `${stage}:${createHash("sha256").update(JSON.stringify(current)).digest("hex")}`;
      yield* controller.recordUsage({ ...delta, eventKey, provider: job.provider, model: sample.model ?? model, stage, priceTableVersion: "openrouter-reported-v1" });
    }
    previous = current;
    if (sample.final && !gap) { yield* controller.confirmUsage(stage); complete = true; }
  }));
  return {
    observe,
    finish: () => Effect.gen(function* () {
      if (!complete || gap) yield* controller.markUsageIncomplete(`Final ${stage} usage is unconfirmed`);
      return complete && !gap;
    }),
  };
});
