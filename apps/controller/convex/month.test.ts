import { describe, expect, it } from "vitest";
import { dayOf, monthOf, workingDays } from "./month";

describe("monthOf", () => {
  it("buckets by the org timezone, not UTC", () => {
    // 2026-08-31 23:30 UTC is already September in Berlin.
    const ts = Date.UTC(2026, 7, 31, 23, 30);
    expect(monthOf(ts, "UTC")).toBe("2026-08");
    expect(monthOf(ts, "Europe/Berlin")).toBe("2026-09");
  });
});

describe("dayOf", () => {
  it("buckets by the org timezone, not UTC", () => {
    const ts = Date.UTC(2026, 8, 13, 22, 30);
    expect(dayOf(ts, "UTC")).toBe("2026-09-13");
    expect(dayOf(ts, "Europe/Berlin")).toBe("2026-09-14");
  });
});

describe("workingDays", () => {
  it("counts Monday to Friday and stops elapsed at today", () => {
    // September 2026 has four Saturdays and four Sundays; the 14th is a Monday.
    expect(workingDays("2026-09", "2026-09-14")).toEqual({ total: 22, elapsed: 10 });
    expect(workingDays("2026-09", "2026-08-20")).toEqual({ total: 22, elapsed: 0 });
    expect(workingDays("2026-09", "2026-10-01")).toEqual({ total: 22, elapsed: 22 });
  });
});
