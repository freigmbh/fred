import { z } from "zod";
import type { Finding } from "./finding";

export const validatorDecision = z.object({
  findingId: z.string().min(1),
  disposition: z.enum(["fixed", "retracted"]),
  reason: z.string().trim().min(1).max(4000),
});

export const savedFindingDecision = validatorDecision.extend({
  expectedDecisionId: z.string().nullable(),
});

// The disposition of a stored finding. Rows from before dispositions existed read as fixed when resolved, else open.
export function dispositionOf(finding: Pick<Finding, "status" | "disposition">) {
  return finding.disposition ?? (finding.status === "resolved" ? "fixed" : "open");
}

// Posted, open findings above nit severity: the ones that keep the findings label on the MR.
export function actionableFindings<T extends Pick<Finding, "status" | "severity" | "disposition">>(findings: readonly T[]) {
  return findings.filter((finding) => finding.status === "posted" && dispositionOf(finding) === "open" && finding.severity !== "nit");
}
