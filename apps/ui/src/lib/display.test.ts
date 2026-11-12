import { describe, expect, it } from "vitest";
import { findingsText, workerText } from "./display";

describe("findingsText", () => {
  it("lists severities in order and leaves out zero counts", () => {
    expect(findingsText({ blocking: 2, should_fix: 0, nit: 1 })).toBe("2 blocking · 1 nit");
    expect(findingsText({ blocking: 0, should_fix: 0, nit: 0 })).toBe("");
  });
});

describe("workerText", () => {
  it("joins the known parts and treats generation 0 as never leased", () => {
    expect(workerText("worker-1", 2)).toBe("worker-1 · lease gen 2");
    expect(workerText(null, 3)).toBe("lease gen 3");
    expect(workerText(null, 0)).toBe("·");
    expect(workerText(null, null)).toBe("·");
  });
});
