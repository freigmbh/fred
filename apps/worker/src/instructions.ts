import { Effect } from "effect";
import type { CheckoutFilesystem } from "./sandbox/filesystem";

const defaultReviewRules = `Find actionable defects introduced by this change. Explain the triggering condition, the affected behavior, and the smallest useful correction. Use blocking for severe correctness or security failures, should_fix for other actionable defects, and nit for minor improvements. Confirm findings against the checkout. Avoid speculative findings and repeated comments.`;

// Loads the repository's review policy at the exact reviewed commit; missing policy is a helpful tip.
export const readInstructions = (files: CheckoutFilesystem) => Effect.gen(function* () {
  const review = yield* files.readOptional("REVIEW.md");
  const agents = yield* files.readOptional("AGENTS.md");
  const conventions = agents ?? (yield* files.readOptional("CLAUDE.md")) ?? "";
  return {
    review: review ?? defaultReviewRules,
    conventions,
    hints: review === undefined ? ["Tip: add REVIEW.md at the repository root to define review rules and reference the repo's review skills."] : [],
  };
});
