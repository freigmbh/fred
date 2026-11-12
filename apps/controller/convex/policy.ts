import type { DenialGate } from "@fred/contracts";

export type PolicyInput = {
  maintenanceMode: boolean;
  globalEnabled: boolean;
  developer: { blocked?: boolean | undefined; blockedReason?: string | undefined };
  projectDeniesProvider: boolean;
  monthSpendUsd: number;
  budgetUsd: number;
  month: string;
};

type PolicyResult = { allowed: true } | { allowed: false; reason: string; gate: DenialGate };
export type Denial = Extract<PolicyResult, { allowed: false }>;

// Applies the gates in the order of `denialGate` and returns the first denial with its comment text, or allowed.
export function evaluatePolicy(input: PolicyInput): PolicyResult {
  if (input.maintenanceMode) return deny("maintenance", "FRED is currently under maintenance. Please request a review again once maintenance is complete.");
  if (!input.globalEnabled) return deny("disabled", "disabled");
  if (input.developer.blocked) {
    return deny("developer_blocked", input.developer.blockedReason ? `blocked, ${input.developer.blockedReason}` : "blocked");
  }
  if (input.projectDeniesProvider) return deny("provider_disallowed", "provider not allowed");
  if (input.monthSpendUsd >= input.budgetUsd) {
    return deny("budget_exhausted", `budget reached, ${input.monthSpendUsd.toFixed(2)} USD of ${input.budgetUsd.toFixed(2)} USD in ${input.month}`);
  }
  return { allowed: true };
}

function deny(gate: DenialGate, reason: string): Denial {
  return { allowed: false, reason, gate };
}
