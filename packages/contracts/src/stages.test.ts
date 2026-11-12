import { describe, expect, it } from "vitest";
import { stage2Output } from "./stages";

describe("stage2Output", () => {
  it("requires a reason on rejected and duplicate verdicts", () => {
    const parsed = stage2Output.safeParse({
      verdicts: [{ index: 0, verdict: "rejected" }],
      findingDecisions: [],
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts a verdict per candidate and finding decisions", () => {
    const parsed = stage2Output.safeParse({
      verdicts: [
        { index: 0, verdict: "accepted" },
        { index: 1, verdict: "duplicate", reason: "raised by codex in discussion 12" },
      ],
      findingDecisions: [{ findingId: "abc", disposition: "fixed", reason: "The current implementation fixes this finding." }],
    });
    expect(parsed.success).toBe(true);
  });

  it("requires evidence and restricts validator decisions to fixes and retractions", () => {
    for (const disposition of ["dismissed", "open"]) {
      expect(stage2Output.safeParse({ verdicts: [], findingDecisions: [{ findingId: "f", disposition, reason: "human choice" }] }).success).toBe(false);
    }
    expect(stage2Output.safeParse({ verdicts: [], findingDecisions: [{ findingId: "f", disposition: "retracted", reason: " " }] }).success).toBe(false);
  });
});
