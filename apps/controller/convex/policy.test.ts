import { describe, expect, it } from "vitest";
import { evaluatePolicy, type PolicyInput } from "./policy";

const allowed: PolicyInput = {
  maintenanceMode: false,
  globalEnabled: true,
  developer: {},
  projectDeniesProvider: false,
  monthSpendUsd: 100,
  budgetUsd: 3000,
  month: "2026-09",
};

describe("evaluatePolicy", () => {
  it("allows when every gate passes", () => {
    expect(evaluatePolicy(allowed)).toEqual({ allowed: true });
  });

  it("checks gates in the documented order", () => {
    const everythingWrong: PolicyInput = {
      maintenanceMode: false,
      globalEnabled: false,
      developer: { blocked: true, blockedReason: "abuse" },
      projectDeniesProvider: true,
      monthSpendUsd: 5000,
      budgetUsd: 3000,
      month: "2026-09",
    };
    expect(evaluatePolicy({ ...everythingWrong, maintenanceMode: true })).toEqual({
      allowed: false,
      reason: "FRED is currently under maintenance. Please request a review again once maintenance is complete.",
      gate: "maintenance",
    });
    expect(evaluatePolicy(everythingWrong)).toEqual({ allowed: false, reason: "disabled", gate: "disabled" });
    expect(evaluatePolicy({ ...everythingWrong, globalEnabled: true })).toEqual({ allowed: false, reason: "blocked, abuse", gate: "developer_blocked" });
    expect(evaluatePolicy({ ...everythingWrong, globalEnabled: true, developer: {} })).toEqual({ allowed: false, reason: "provider not allowed", gate: "provider_disallowed" });
    expect(evaluatePolicy({ ...everythingWrong, globalEnabled: true, developer: {}, projectDeniesProvider: false })).toMatchObject({
      allowed: false,
      gate: "budget_exhausted",
      reason: "budget reached, 5000.00 USD of 3000.00 USD in 2026-09",
    });
  });

  it("denies at exactly the budget", () => {
    expect(evaluatePolicy({ ...allowed, monthSpendUsd: 3000 })).toMatchObject({ allowed: false });
  });
});
