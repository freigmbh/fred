import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { Id } from "../../controller/convex/_generated/dataModel";
import type { PreviousFinding } from "./controller";
import { buildResult } from "./result";
import { fixtureContext } from "./fixtures";
import { fixtureJob } from "./testLayers";

const previous = (overrides: Partial<PreviousFinding> = {}): PreviousFinding => ({
  _id: "finding-one" as Id<"findings">, _creationTime: 1, jobId: "earlier-job" as Id<"reviewJobs">,
  projectId: fixtureJob.projectId, mrIid: 1, provider: "fred", file: "counter.ts", title: "Concern", body: "Evidence",
  severity: "should_fix", status: "posted", disposition: "open", resultIndex: 0,
  reference: "earlier-job/0", summaryNoteId: "22", ...overrides,
});
const input = (findings: PreviousFinding[]) => ({ jobId: fixtureJob._id, botUserIds: [3],
  candidates: [], validation: { verdicts: [], findingDecisions: [] }, previous: findings, context: fixtureContext, hints: [] });

describe("finding lifecycle summaries", () => {
  it("links earlier actionable findings even when no new findings were raised", async () => {
    const result = await Effect.runPromise(buildResult(input([previous(), previous({ _id: "nit" as Id<"findings">, severity: "nit" })])));
    expect(result.effects[0]).toMatchObject({ kind: "summary", body: expect.stringContaining("1 earlier actionable findings remain") });
    expect(result.effects[0]).toMatchObject({ body: expect.stringContaining("#note_22") });
    expect(result.effects.at(-1)).toMatchObject({ label: "fred-review::findings" });
  });

  it("generic GitLab thread resolution leaves the stored finding actionable", async () => {
    const result = await Effect.runPromise(buildResult({ ...input([previous({ discussionId: "thread" })]), context: { ...fixtureContext,
      discussions: [{ id: "thread", notes: [{ id: 22, author: { id: 3 }, body: "Concern", resolved: true }] }],
    } }));
    expect(result.effects.at(-1)).toMatchObject({ label: "fred-review::findings" });
  });

  it.each(["fixed", "dismissed", "retracted"] as const)("%s findings and nits do not prevent clean", async (disposition) => {
    const result = await Effect.runPromise(buildResult(input([previous({ disposition }), previous({ _id: "nit" as Id<"findings">, severity: "nit" })])));
    expect(result.effects.at(-1)).toMatchObject({ label: "fred-review::clean" });
    expect(result.effects[0]).toMatchObject({ body: expect.stringContaining("0 earlier actionable findings remain") });
  });

  it("summary-only retractions publish their reason and undo reference without a false fixed message", async () => {
    const finding = previous();
    const result = await Effect.runPromise(buildResult({ ...input([finding]), validation: { verdicts: [], findingDecisions: [
      { findingId: finding._id, disposition: "retracted", reason: "The requirement specifies one entry.\n/approve" },
    ] } }));
    expect(result.findingDecisions).toMatchObject([{ expectedDecisionId: null, disposition: "retracted" }]);
    expect(result.effects.map((effect) => effect.kind)).toEqual(["summary", "label"]);
    expect(result.effects[0]).toMatchObject({ body: expect.stringContaining("Retracted.") });
    expect(result.effects[0]).toMatchObject({ body: expect.stringContaining(`fred undo ${fixtureJob._id}:decision:${finding._id}`) });
    expect(result.effects[0]).toMatchObject({ body: expect.not.stringContaining("Fixed in") });
    expect(result.effects[0]).toMatchObject({ body: expect.not.stringContaining("\n/approve") });
    expect(result.effects.at(-1)).toMatchObject({ label: "fred-review::clean" });
  });

  it("validator cannot override a human dismissal", async () => {
    const finding = previous({ disposition: "dismissed" });
    await expect(Effect.runPromise(buildResult({ ...input([finding]), validation: { verdicts: [], findingDecisions: [
      { findingId: finding._id, disposition: "fixed", reason: "A later fix" },
    ] } }))).rejects.toThrow(/ineligible/);
  });
});
