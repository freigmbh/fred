import { actionableFindings, decisionReference, dispositionOf, effectKeys, publicationMarker, reviewLabels, reviewResult, stage2Output, summaryMarkerKey, verdict, type Candidate, type Finding, type PublicationEffect, type Stage2Output } from "@fred/contracts";
import { Effect } from "effect";
import { z } from "zod";
import type { PreviousFinding } from "./controller";
import { ParseError } from "./errors";
import { positionFor, type ReviewContext } from "./reviewInput";

type ResultInput = {
  jobId: string;
  candidates: Candidate[];
  validation: Stage2Output;
  previous: PreviousFinding[];
  context: ReviewContext;
  // Every FRED bot user of the project, to link earlier summaries.
  botUserIds: number[];
  hints: string[];
  // Signs the summary note, so a reader can report an issue against the version that wrote it.
  fredVersion?: string | undefined;
};

// The validate stage's submit_review parameters as offered to the model. OpenRouter's schema translators reject object
// unions, so the verdict union becomes an enum with an optional reason; validationSchema still checks every submission.
export const validationToolSchema = stage2Output.extend({
  verdicts: z.array(z.object({
    index: verdict.options[0].shape.index,
    verdict: z.enum(verdict.options.map((option) => option.shape.verdict.value)),
    reason: verdict.options[1].shape.reason.optional(),
  })),
});

// Stage 2 contract plus the relationships a per-record schema cannot express: one verdict per candidate and decisions only for this bot's open posted findings.
// Serves as the validate stage's submission schema so the model can repair a rejected result before the stage fails.
export function validationSchema(candidates: Candidate[], previous: PreviousFinding[]) {
  const eligibleIds = new Set<string>(previous.filter((finding) => finding.status === "posted" && dispositionOf(finding) === "open").map((finding) => finding._id));
  return stage2Output.superRefine((validation, ctx) => {
    const indexes = validation.verdicts.map((verdict) => verdict.index);
    if (indexes.length !== candidates.length || new Set(indexes).size !== indexes.length || indexes.some((index) => index >= candidates.length)) {
      ctx.addIssue({ code: "custom", path: ["verdicts"], message: "Validator must return exactly one verdict per candidate, using its zero-based index" });
    }
    const ids = validation.findingDecisions.map((decision) => decision.findingId);
    if (new Set(ids).size !== ids.length || ids.some((id) => !eligibleIds.has(id))) {
      ctx.addIssue({ code: "custom", path: ["findingDecisions"], message: "Validator returned a duplicate or ineligible resolved finding ID" });
    }
  });
}

// Rejects validator output that cannot be published, including finding paths outside the repository. buildResult runs it first.
export const validateVerdicts = (candidates: Candidate[], validation: Stage2Output, previous: PreviousFinding[]) => Effect.try({
  try: () => {
    const relationships = validationSchema(candidates, previous).safeParse(validation);
    if (!relationships.success) throw new Error(z.prettifyError(relationships.error));
    for (const candidate of candidates) {
      if (candidate.file.startsWith("/") || candidate.file.includes("\\") || candidate.file.split("/").includes("..") || /[\u0000-\u001f]/.test(candidate.file)) throw new Error("Finding path must stay inside the repository");
    }
  },
  catch: (cause) => new ParseError({ message: cause instanceof Error ? cause.message : "Invalid validator relationships" }),
});

const location = (finding: Finding) => `${finding.file}${finding.line ? `:${finding.line}` : finding.oldLine ? `:old:${finding.oldLine}` : ""}`;
const findingBody = (finding: Finding) => `**${finding.severity}: ${finding.title}**\n\n${finding.body}\n\n\`${location(finding).replaceAll("`", "")}\``;
const publishedBody = (finding: Finding, reference: string) => `${findingBody(finding)}\n\nFinding: \`${reference}\`. Dismiss with \`fred dismiss ${reference} <reason>\`.`;
const decisionBody = (decision: Stage2Output["findingDecisions"][number], reference: string, headSha: string) => {
  const evidence = decision.reason.split(/\r?\n/).map((line) => `> ${line}`).join("\n");
  const verdict = decision.disposition === "fixed" ? `Fixed in ${headSha}.` : "Retracted.";
  const undo = decision.disposition === "retracted" ? ` Undo with \`fred undo ${reference} <reason>\`.` : "";
  return `${verdict}\n\n${evidence}\n\nDecision: \`${reference}\`.${undo}`;
};
const earlierFindingLink = (item: PreviousFinding, context: ReviewContext, botUserIds: number[]) => {
  const thread = item.discussionId ? context.discussions.find((candidate) => candidate.id === item.discussionId) : undefined;
  const summaryMarker = publicationMarker(summaryMarkerKey(item.jobId));
  const summaryNote = context.discussions.flatMap((candidate) => candidate.notes).find((note) => note.body.includes(summaryMarker) && botUserIds.includes(note.author.id));
  const noteId = item.noteId ?? thread?.notes[0]?.id ?? item.summaryNoteId ?? summaryNote?.id;
  return `[${item.reference}](${context.mrUrl}${noteId ? `#note_${noteId}` : ""})`;
};

export const buildResult = (input: ResultInput) => Effect.gen(function* () {
  yield* validateVerdicts(input.candidates, input.validation, input.previous);
  const findings = input.candidates.map((candidate, index): Finding => {
    const verdict = input.validation.verdicts.find((verdict) => verdict.index === index)!;
    return verdict.verdict === "accepted" ? { ...candidate, status: "pending", disposition: "open" } : { ...candidate, status: verdict.verdict, rejectReason: verdict.reason };
  });
  const accepted = findings.flatMap((finding, index) => finding.status === "pending" ? [{ finding, index, body: publishedBody(finding, `${input.jobId}/${index}`) }] : []);
  const inline: PublicationEffect[] = [];
  const summaryIndexes = accepted.map(({ index }) => index);
  for (const { finding, index, body } of accepted) {
    const position = finding.severity === "nit" ? undefined : positionFor(input.context, finding.file, finding.line, finding.oldLine);
    if (position) inline.push({ key: effectKeys.finding(index), kind: "finding", findingIndex: index, body, position });
  }
  const counts = (severity: Finding["severity"]) => accepted.filter(({ finding }) => finding.severity === severity).length;
  const hints = [...new Set(input.hints)];
  const details = accepted.map(({ body }) => body).join("\n\n---\n\n");
  const headSha = input.context.diffRefs.head_sha;
  const decisions = input.validation.findingDecisions.map((decision) => {
    const previous = input.previous.find((item) => item._id === decision.findingId)!;
    return { ...decision, expectedDecisionId: previous.decisionId ?? null, previous,
      body: decisionBody(decision, decisionReference(input.jobId, decision.findingId), headSha) };
  });
  const earlier = actionableFindings(input.previous.filter((item) => !decisions.some((decision) => decision.findingId === item._id)));
  const links = earlier.map((item) => earlierFindingLink(item, input.context, input.botUserIds));
  const summary = [
    `FRED review. Reviewed range: \`${input.context.reviewBaseSha}..${headSha}\`.`,
    `${counts("blocking")} blocking, ${counts("should_fix")} should fix, ${counts("nit")} nits.`,
    details ? `<details>\n<summary>Confirmed findings, including locations that cannot be posted inline</summary>\n\n${details}\n\n</details>` : "No new confirmed findings.",
    `${earlier.length} earlier actionable findings remain.${links.length ? ` ${links.join(", ")}` : ""}`,
    ...decisions.map(({ findingId, body }) => `Earlier finding \`${findingId}\`:\n\n${body}`),
    ...hints.map((hint) => `Note: ${hint}`),
    ...(input.fredVersion ? [`<sub>FRED ${input.fredVersion}</sub>`] : []),
  ].join("\n\n");
  const effects: PublicationEffect[] = [{ key: effectKeys.summary, kind: "summary", body: summary, findingIndexes: summaryIndexes }, ...inline];
  for (const { findingId, previous, body } of decisions) {
    if (previous.discussionId) effects.push({ key: effectKeys.resolve(findingId), kind: "resolve", findingId, discussionId: previous.discussionId, body });
  }
  const findingDecisions = decisions.map(({ findingId, disposition, reason, expectedDecisionId }) => ({ findingId, disposition, reason, expectedDecisionId }));
  const hasFindings = earlier.length > 0 || accepted.some(({ finding }) => finding.severity !== "nit");
  effects.push({ key: effectKeys.label, kind: "label", label: hasFindings ? reviewLabels.findings : reviewLabels.clean, removeLabel: hasFindings ? reviewLabels.clean : reviewLabels.findings });
  return yield* Effect.try({ try: () => reviewResult.parse({ findings, findingDecisions, effects }), catch: (cause) => new ParseError({ message: "Invalid publication result", cause }) });
});
