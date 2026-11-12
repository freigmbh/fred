import { z } from "zod";
import { finding } from "./finding";
import { savedFindingDecision } from "./findingLifecycle";

const diffPosition = z.object({
  baseSha: z.string().min(1),
  startSha: z.string().min(1),
  headSha: z.string().min(1),
  oldPath: z.string().min(1),
  newPath: z.string().min(1),
  newLine: z.number().int().positive().optional(),
  oldLine: z.number().int().positive().optional(),
});

export const publicationEffect = z.discriminatedUnion("kind", [
  z.object({ key: z.string().min(1), kind: z.literal("finding"), findingIndex: z.number().int().nonnegative(), body: z.string().min(1), position: diffPosition.optional() }),
  z.object({ key: z.string().min(1), kind: z.literal("summary"), body: z.string().min(1), findingIndexes: z.array(z.number().int().nonnegative()) }),
  z.object({ key: z.string().min(1), kind: z.literal("resolve"), findingId: z.string().min(1), discussionId: z.string().min(1), body: z.string().min(1) }),
  z.object({ key: z.string().min(1), kind: z.literal("label"), label: z.string().min(1), removeLabel: z.string().min(1) }),
]);

// The worker saves this immutable publication intent before its first GitLab write.
export const reviewResult = z.object({
  findings: z.array(finding),
  findingDecisions: z.array(savedFindingDecision),
  effects: z.array(publicationEffect),
}).superRefine((result, ctx) => {
  if (new Set(result.effects.map((effect) => effect.key)).size !== result.effects.length) {
    ctx.addIssue({ code: "custom", message: "publication effect keys must be unique" });
  }
  if (new Set(result.findingDecisions.map((decision) => decision.findingId)).size !== result.findingDecisions.length) {
    ctx.addIssue({ code: "custom", message: "finding decisions must be unique" });
  }
  const summary = result.effects[0];
  if (summary?.kind !== "summary" || result.effects.filter((effect) => effect.kind === "summary").length !== 1) {
    ctx.addIssue({ code: "custom", message: "publication requires exactly one summary as its first effect" });
  }
  const summaryIndexes = summary?.kind === "summary" ? summary.findingIndexes : [];
  const inlineIndexes: number[] = [];
  for (const effect of result.effects) {
    if (effect.kind === "finding") inlineIndexes.push(effect.findingIndex);
    if (effect.kind === "resolve" && !result.findingDecisions.some((decision) => decision.findingId === effect.findingId)) {
      ctx.addIssue({ code: "custom", message: "resolution effect must reference a finding decision" });
    }
  }
  if (new Set(summaryIndexes).size !== summaryIndexes.length || new Set(inlineIndexes).size !== inlineIndexes.length) {
    ctx.addIssue({ code: "custom", message: "a finding must appear once in the summary and at most once inline" });
  }
  for (const index of [...summaryIndexes, ...inlineIndexes]) {
    if (result.findings[index]?.status !== "pending") {
      ctx.addIssue({ code: "custom", message: "publication effect must reference a pending finding" });
    }
  }
  result.findings.forEach((item, index) => {
    const unpublished = item.status === "pending" || item.status === "rejected" || item.status === "duplicate";
    const openOrUndecided = item.disposition === undefined || (item.status === "pending" && item.disposition === "open");
    if (!unpublished || !openOrUndecided) {
      ctx.addIssue({ code: "custom", message: "new results must contain pending, rejected, or duplicate findings" });
    }
    if (item.status === "pending" && !summaryIndexes.includes(index)) {
      ctx.addIssue({ code: "custom", message: "pending finding requires summary coverage" });
    }
  });
});

export type ReviewResult = z.infer<typeof reviewResult>;
export type PublicationEffect = z.infer<typeof publicationEffect>;
