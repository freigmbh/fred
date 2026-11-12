import { z } from "zod";
import { candidate } from "./finding";
import { validatorDecision } from "./findingLifecycle";

// Stage 1 output: everything the detector wants a second opinion on.
export const stage1Output = z.object({
  candidates: z.array(candidate),
});

// Stage 2 verdict per candidate, indexed by position in the stage 1 list.
// Rules apply in order: not confirmed in code, already raised by a human or
// a bot, otherwise accepted.
export const verdict = z.discriminatedUnion("verdict", [
  z.object({ index: z.number().int().nonnegative(), verdict: z.literal("accepted") }),
  z.object({ index: z.number().int().nonnegative(), verdict: z.literal("rejected"), reason: z.string().min(1) }),
  z.object({ index: z.number().int().nonnegative(), verdict: z.literal("duplicate"), reason: z.string().min(1) }),
]);

export const stage2Output = z.object({
  verdicts: z.array(verdict),
  findingDecisions: z.array(validatorDecision),
});

export type Stage2Output = z.infer<typeof stage2Output>;
