import { describe, expect, it } from "vitest";
import { readReviewResult } from "./legacyReviewResult";
import { reviewResult } from "./reviewResult";

const pending = { file: "deleted.ts", oldLine: 3, severity: "blocking", title: "bug", body: "details", status: "pending" };
const summary = { kind: "summary", key: "summary", body: "bug", findingIndexes: [0] };
const effect = { kind: "finding", key: "finding:0", findingIndex: 0, body: "bug" };

describe("reviewResult", () => {
  it("represents deleted lines and file-level findings without fabricated new lines", () => {
    expect(reviewResult.parse({ findings: [pending], findingDecisions: [], effects: [summary, effect] }).findings[0]?.oldLine).toBe(3);
    expect(reviewResult.safeParse({ findings: [{ ...pending, oldLine: undefined }], findingDecisions: [], effects: [summary, effect] }).success).toBe(true);
  });

  it("rejects missing, repeated, and out-of-range publication coverage", () => {
    for (const effects of [[], [effect, summary], [summary, summary], [{ ...summary, findingIndexes: [] }, effect],
      [{ ...summary, findingIndexes: [0, 0] }], [summary, effect, { ...effect, key: "again" }],
      [{ ...summary, findingIndexes: [2] }], [summary, { ...effect, findingIndex: 2 }], [summary, effect, effect]]) {
      expect(reviewResult.safeParse({ findings: [pending], findingDecisions: [], effects }).success).toBe(false);
    }
  });

  it("permits summary coverage with optional inline enrichment and rejects publishing discarded findings", () => {
    expect(reviewResult.safeParse({ findings: [pending], findingDecisions: [], effects: [summary] }).success).toBe(true);
    expect(reviewResult.safeParse({ findings: [{ ...pending, status: "duplicate", rejectReason: "already raised" }], findingDecisions: [], effects: [summary, effect] }).success).toBe(false);
  });

  it("rejects a new pending finding that already has a closed disposition", () => {
    expect(reviewResult.safeParse({ findings: [{ ...pending, disposition: "dismissed" }], findingDecisions: [], effects: [summary] }).success).toBe(false);
  });

  it("decodes v1 saved intent as fixed decisions while keeping its publication keys", () => {
    const effects = [
      { kind: "summary", key: "summary", findingIndexes: [], body: "old summary" },
      { kind: "resolve", key: "resolve:f", findingId: "f", discussionId: "d", body: "Fixed in old-sha." },
    ];
    expect(readReviewResult({ findings: [], resolvedFindingIds: ["f"], effects })).toMatchObject({
      findingDecisions: [{ findingId: "f", disposition: "fixed", expectedDecisionId: null }], effects,
    });
  });

  it("rejects resolution effects outside the declared prior finding set", () => {
    expect(reviewResult.safeParse({ findings: [], findingDecisions: [], effects: [
      { ...summary, findingIndexes: [] },
      { key: "resolve", kind: "resolve", findingId: "other", discussionId: "d1", body: "fixed" },
    ] }).success).toBe(false);
  });
});
