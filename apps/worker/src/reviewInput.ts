import type { PublicationEffect } from "@fred/contracts";
import type { z } from "zod";
import type { Diff, diffRefs, discussion } from "./gitlab/schemas";

// A changed file as both stages review it. `recovery` supplies verified raw context for an omitted API patch or file and
// disables inline anchors; its optional hint is included in the summary.
export type ReviewFile = Diff & { recovery?: { context: string; hint?: string } };

export type Position = Extract<PublicationEffect, { kind: "finding" }>["position"];

// The verified MR state one review analyses: the full MR diff, the incremental scope, and existing discussions.
export type ReviewContext = {
  mrUrl: string; title: string; description: string; reviewBaseSha: string; diffRefs: z.infer<typeof diffRefs>;
  fullDiff: ReviewFile[]; reviewDiff: ReviewFile[]; discussions: z.infer<typeof discussion>[]; hints: string[]; cloneUrl: string;
  // True when the incremental comparison against the baseline is empty, so no analysis is needed.
  unchangedSinceBaseline?: boolean;
};

// One line of patch text as a UTF-16 span, with the one-based file lines it occupies. Hunk headers, metadata,
// and lines outside a hunk carry neither line.
export type PatchLine = { start: number; end: number; oldLine: number | null; newLine: number | null };

// Splits patch text into lines. A `diff --git` header ends the current hunk, so concatenated recovery sections index too.
export function indexPatch(text: string) {
  const lines: PatchLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (let start = 0; start < text.length;) {
    const newline = text.indexOf("\n", start);
    const end = newline < 0 ? text.length : newline + 1;
    const line = text.slice(start, end);
    const span: PatchLine = { start, end, oldLine: null, newLine: null };
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); inHunk = true; }
    else if (line.startsWith("diff --git ")) inHunk = false;
    else if (inHunk && line.startsWith(" ")) { span.oldLine = oldLine++; span.newLine = newLine++; }
    else if (inHunk && line.startsWith("-")) span.oldLine = oldLine++;
    else if (inHunk && line.startsWith("+")) span.newLine = newLine++;
    lines.push(span);
    start = end;
  }
  return lines;
}

// The inline anchor of a finding: only lines the full MR diff actually shows, deletions included. Recovered stand-ins have none.
export const positionFor = (context: Pick<ReviewContext, "fullDiff" | "diffRefs">, file: string, line?: number, oldLine?: number): Position => {
  const change = context.fullDiff.find((entry) => entry.new_path === file || entry.old_path === file);
  if (!change || change.recovery) return undefined;
  const anchor = indexPatch(change.diff).find((span) => line !== undefined ? span.newLine === line : oldLine !== undefined && span.oldLine === oldLine);
  if (!anchor) return undefined;
  return {
    baseSha: context.diffRefs.base_sha, startSha: context.diffRefs.start_sha, headSha: context.diffRefs.head_sha, oldPath: change.old_path, newPath: change.new_path,
    ...(anchor.newLine === null ? {} : { newLine: anchor.newLine }), ...(anchor.oldLine === null ? {} : { oldLine: anchor.oldLine }),
  };
};
