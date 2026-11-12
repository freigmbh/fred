import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { makeController } from "./controller";
import { ControllerError } from "./errors";
import type { UsageSnapshot } from "./provider";
import { fixtureJob, testServices } from "./testLayers";
import { makeUsage } from "./usage";

type RecordUsage = Parameters<ReturnType<ReturnType<typeof makeController>["forJob"]>["recordUsage"]>[0];
const snapshot: UsageSnapshot = { inputTokens: 100, cachedInputTokens: 20, outputTokens: 10, cacheCreationInputTokens: 0, costUsd: 0.003, final: false };

describe("observed usage accounting", () => {
  it("records OpenRouter cost and resolved model without requiring a price entry", async () => {
    const test = testServices();
    const records: RecordUsage[] = [];
    const control = { ...test.control, recordUsage: (record: RecordUsage) => { records.push(record); return test.control.recordUsage(); } };
    const usage = await Effect.runPromise(makeUsage(fixtureJob, control, "detect", "google/model-alias"));
    await Effect.runPromise(usage.observe({ ...snapshot, model: "google/resolved-model", final: true }));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ provider: "fred", model: "google/resolved-model", stage: "detect", costUsd: 0.003, priceTableVersion: "openrouter-reported-v1" });
  });

  it("preserves later known costs after a missing cost and leaves accounting incomplete", async () => {
    const test = testServices();
    const records: RecordUsage[] = [];
    const control = { ...test.control, recordUsage: (record: RecordUsage) => { records.push(record); return test.control.recordUsage(); } };
    const usage = await Effect.runPromise(makeUsage(fixtureJob, control, "detect", "google/model"));
    await Effect.runPromise(usage.observe(snapshot));
    await Effect.runPromise(usage.observe({ ...snapshot, inputTokens: 200, outputTokens: 20, costUsd: undefined }));
    await Effect.runPromise(usage.observe({ ...snapshot, inputTokens: 300, outputTokens: 30, costUsd: 0.007, final: true }));
    expect(records).toHaveLength(2);
    expect(records[1]).toMatchObject({ inputTokens: 100, outputTokens: 10, costUsd: 0.004 });
    expect(await Effect.runPromise(usage.finish())).toBe(false);
    expect(test.calls).not.toContain("confirmUsage");
  });

  it("replays the same ledger identity after an ambiguous acknowledgement", async () => {
    const test = testServices();
    const records: RecordUsage[] = [];
    let first = true;
    const control = { ...test.control, recordUsage: (record: RecordUsage) => Effect.gen(function* () {
      records.push(record);
      if (first) { first = false; return yield* Effect.fail(new ControllerError({ message: "response lost" })); }
      return yield* test.control.recordUsage();
    }) };
    const usage = await Effect.runPromise(makeUsage(fixtureJob, control, "detect", "gpt-6-astra"));
    const cachedSnapshot = { ...snapshot, cacheCreationInputTokens: 5 };
    await expect(Effect.runPromise(usage.observe(cachedSnapshot))).rejects.toThrow("response lost");
    await Effect.runPromise(usage.observe(cachedSnapshot));
    await Effect.runPromise(usage.observe({ ...cachedSnapshot, final: true }));
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual(records[1]);
    expect(records[0]?.costUsd).toBe(0.003);
    expect(await Effect.runPromise(usage.finish())).toBe(true);
  });

  it("flags counter resets instead of emitting negative corrections or zero-cost estimates", async () => {
    const test = testServices();
    const usage = await Effect.runPromise(makeUsage(fixtureJob, test.control, "detect", "gpt-5.6-sol"));
    await Effect.runPromise(usage.observe(snapshot));
    await Effect.runPromise(usage.observe({ ...snapshot, inputTokens: 0, outputTokens: 0, final: true }));
    expect(await Effect.runPromise(usage.finish())).toBe(false);
    expect(test.calls.filter((call) => call === "usage")).toHaveLength(1);
    expect(test.calls).not.toContain("confirmUsage");
  });
});
