import { stage1Output, stage2Output } from "@fred/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import fixture from "../../../fixtures/reviews/basic.json";
import { buildResult, validateVerdicts, validationSchema } from "./result";
import { fixtureContext } from "./fixtures";

const candidates = stage1Output.parse(fixture.detect).candidates;
const validation = stage2Output.parse(fixture.validate);

describe("validated publication intent", () => {
  it("rejects duplicate and out-of-range indexes before the validation stage completes", () => {
    const schema = validationSchema([candidates[0]!, candidates[0]!], []);
    for (const indexes of [[0, 0], [0, 2], [-1, 0]]) {
      expect(schema.safeParse({ verdicts: indexes.map((index) => ({ index, verdict: "accepted" })), findingDecisions: [] }).success).toBe(false);
    }
    expect(schema.safeParse({ verdicts: [1, 0].map((index) => ({ index, verdict: "accepted" })), findingDecisions: [] }).success).toBe(true);
    expect(validationSchema([], []).safeParse({ verdicts: [], findingDecisions: [] }).success).toBe(true);
  });

  it("rejects repeated verdicts and foreign resolution IDs", async () => {
    await expect(Effect.runPromise(validateVerdicts(candidates, { verdicts: [validation.verdicts[0]!, validation.verdicts[0]!], findingDecisions: [] }, []))).rejects.toThrow("exactly one");
    await expect(Effect.runPromise(validateVerdicts(candidates, { ...validation, findingDecisions: [{ findingId: "foreign", disposition: "fixed", reason: "The current implementation fixes this finding." }] }, []))).rejects.toThrow("ineligible");
  });

  it("acknowledges every visible summary finding before optional inline publication", async () => {
    const result = await Effect.runPromise(buildResult({ jobId: "fixture-job", botUserIds: [3], candidates, validation, previous: [], context: fixtureContext, hints: [] }));
    expect(result.effects[0]).toMatchObject({ kind: "summary", findingIndexes: [0], body: expect.stringMatching(/^FRED review\. Reviewed range: /) });
    expect(result.effects[1]).toMatchObject({ kind: "finding", findingIndex: 0 });
  });

  it("signs the summary note with the FRED version that wrote it", async () => {
    const result = await Effect.runPromise(buildResult({ jobId: "fixture-job", botUserIds: [3], candidates, validation, previous: [], context: fixtureContext, hints: [], fredVersion: "0.3.1" }));
    expect(result.effects[0]).toMatchObject({ kind: "summary", body: expect.stringMatching(/\n\n<sub>FRED 0\.3\.1<\/sub>$/) });
  });

  it("retains a confirmed deleted-file finding in the summary without fabricating an inline position", async () => {
    const result = await Effect.runPromise(buildResult({ jobId: "fixture-job", botUserIds: [3], candidates: [{ ...candidates[0]!, file: "deleted.ts", line: undefined, oldLine: 8 }], validation, previous: [], context: fixtureContext, hints: ["missing skill", "missing skill"] }));
    expect(result.effects.map((effect) => effect.kind)).toEqual(["summary", "label"]);
    expect(result.effects[0]).toMatchObject({ findingIndexes: [0] });
    expect(result.effects[0]!.kind === "summary" && result.effects[0]!.body).toContain("deleted.ts:old:8");
  });

  it("stores rejected candidates and keeps nits out of the findings label", async () => {
    const result = await Effect.runPromise(buildResult({ jobId: "fixture-job", botUserIds: [3], candidates: [{ ...candidates[0]!, severity: "nit" }], validation, previous: [], context: fixtureContext, hints: [] }));
    expect(result.effects.at(-1)).toMatchObject({ kind: "label", label: "fred-review::clean" });
    const rejected = await Effect.runPromise(buildResult({ jobId: "fixture-job", botUserIds: [3], candidates, validation: { verdicts: [{ index: 0, verdict: "rejected", reason: "Not confirmed" }], findingDecisions: [] }, previous: [], context: fixtureContext, hints: [] }));
    expect(rejected.findings).toMatchObject([{ status: "rejected", rejectReason: "Not confirmed" }]);
  });
});
