import { z } from "zod";
import { reviewResult } from "./reviewResult";

const legacyReviewResult = z.looseObject({ resolvedFindingIds: z.array(z.string().min(1)) });

// Decodes saved v1 intent without rewriting its stored JSON or publication markers.
export function readReviewResult(value: unknown) {
  if (typeof value === "object" && value !== null && "findingDecisions" in value) return reviewResult.parse(value);
  const { resolvedFindingIds, ...rest } = legacyReviewResult.parse(value);
  return reviewResult.parse({ ...rest, findingDecisions: resolvedFindingIds.map((findingId) => ({
    findingId, disposition: "fixed", reason: "Code fix verified by the original review.", expectedDecisionId: null,
  })) });
}
