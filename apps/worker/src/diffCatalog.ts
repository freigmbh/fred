import { Effect } from "effect";
import { z } from "zod";
import { ProviderError, SandboxError } from "./errors";
import { indexPatch, type PatchLine, type ReviewContext, type ReviewFile } from "./reviewInput";

export const maximumPageBytes = 32 * 1024;
const maximumInlinePatchBytes = 12 * 1024;

const pageBudget = z.number().int().min(1024).max(maximumPageBytes).default(16 * 1024);
const cursor = z.object({ line: z.number().int().nonnegative(), column: z.number().int().nonnegative() }).strict();
const range = z.enum(["scope", "full"]);
export const readDiffInput = z.object({
  id: z.string().min(1).max(100),
  range: range.default("scope"),
  cursor: cursor.default({ line: 0, column: 0 }),
  maxBytes: pageBudget,
}).strict();
export const listDiffsInput = z.object({ cursor: z.number().int().nonnegative().default(0), maxBytes: pageBudget }).strict();
// The JSON a read_diff call returns.
export const diffPage = z.object({
  id: z.string(), range, inlineAnchors: z.boolean(),
  lines: z.array(cursor.extend({ oldLine: z.number().int().nullable(), newLine: z.number().int().nullable(), text: z.string() })),
  nextCursor: cursor.nullable(),
});
// The JSON a list_diffs call returns.
export const catalogPage = z.object({ text: z.string(), nextCursor: z.number().int().nonnegative().nullable() });
type Range = z.infer<typeof range>;
type Cursor = z.infer<typeof cursor>;

const deferredHint = "Diff ranges were available on demand through read_diff. This does not establish which ranges the model read.";
const manifestLegend = "path is the new path, oldPath is present only when different; scopeAndFull means identical ranges; scope=null means full-MR context only";
const patchesHeading = "\n\nINLINE PATCHES (use read_diff for every other patch; an available patch is not proof it was reviewed):\n";

// Raised when the fixed prompt sections leave no room for even the paged catalog instructions.
export const oversizedReviewInput = () => new ProviderError({
  message: "Review rules and metadata exceed the initial prompt budget",
  diagnostic: { category: "invalid_request", code: "review_input_too_large" },
});

const byteLength = (text: string) => Buffer.byteLength(text, "utf8");
const lineCount = (text: string) => text === "" ? 0 : text.split("\n").length - Number(text.endsWith("\n"));
// True when slicing at `offset` would separate a surrogate pair into invalid UTF-16 halves.
const splitsSurrogate = (text: string, offset: number) => offset > 0 && offset < text.length
  && /[\uD800-\uDBFF]/.test(text[offset - 1]!) && /[\uDC00-\uDFFF]/.test(text[offset]!);

// Binary search for the largest length up to `limit` that still fits. `fits` must hold for every shorter length once it holds.
function largestFit(limit: number, fits: (length: number) => boolean) {
  let low = 0;
  let high = limit;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(mid)) low = mid;
    else high = mid - 1;
  }
  return low;
}

// One range's patch, copied out of the caller-owned diff so later mutations cannot change served pages. Recovered raw context has no inline anchors.
type Patch = { text: string; inlineAnchors: boolean; header: string };
const toPatch = (file: ReviewFile | undefined): Patch | undefined => file && {
  text: file.recovery?.context ?? file.diff,
  inlineAnchors: file.recovery === undefined,
  header: `diff --git a/${file.old_path} b/${file.new_path}\n`,
};
const samePatch = (left: Patch, right: Patch) => left.text === right.text && left.inlineAnchors === right.inlineAnchors;
const summarize = (patch: Patch | undefined) => patch === undefined ? null : Object.freeze({
  bytes: byteLength(patch.text), lines: lineCount(patch.text), inlineAnchors: patch.inlineAnchors,
});
const changeKind = (file: ReviewFile) => file.deleted_file ? "deleted" : file.new_file ? "added" : file.renamed_file ? "renamed" : "modified";
const fileKey = (file: ReviewFile) => JSON.stringify([file.old_path, file.new_path]);

// Indexes the verified full and incremental diffs once per job. Both stages render its manifest into the prompt and page patches through read_diff and list_diffs.
export function makeDiffCatalog(context: Pick<ReviewContext, "fullDiff" | "reviewDiff">) {
  const full = new Map(context.fullDiff.map((file) => [fileKey(file), file]));
  const scope = new Map(context.reviewDiff.map((file) => [fileKey(file), file]));
  const items = [...new Set([...full.keys(), ...scope.keys()])].map((key, index) => {
    const file = (scope.get(key) ?? full.get(key))!;
    const patches: Record<Range, Patch | undefined> = { scope: toPatch(scope.get(key)), full: toPatch(full.get(key)) };
    const shared = patches.scope !== undefined && patches.full !== undefined && samePatch(patches.scope, patches.full);
    const entry = Object.freeze({
      id: `d${index + 1}`, oldPath: file.old_path, newPath: file.new_path, change: changeKind(file),
      scope: summarize(patches.scope), full: summarize(patches.full), shared,
    });
    return { entry, patches };
  });
  const entries = Object.freeze(items.map(({ entry }) => entry));
  const indexed = new Map<Patch, PatchLine[]>();
  const linesOf = (patch: Patch) => {
    const lines = indexed.get(patch) ?? indexPatch(patch.text);
    indexed.set(patch, lines);
    return lines;
  };

  const manifestRows = entries.map((entry) => JSON.stringify({
    id: entry.id, path: entry.newPath, ...(entry.oldPath === entry.newPath ? {} : { oldPath: entry.oldPath }), change: entry.change,
    ...(entry.shared ? { scopeAndFull: entry.scope } : { scope: entry.scope, full: entry.full }),
  })).join("\n");
  const inlineManifest = `CHANGED FILES (all entries; ${manifestLegend}):\n${manifestRows || "No changed files."}${patchesHeading}`;
  const pagedManifest = `CHANGED FILES (${entries.length} entries; ${manifestLegend}):\nThe catalog is available through list_diffs. Read every page before selecting patches to inspect. Concatenate returned text to reconstruct the JSON-lines catalog; a long row may span pages. Follow nextCursor until null. No patches are inlined; use read_diff for patch text.`;

  // Renders the manifest and as many small patches as the budget allows; the paged manifest replaces both when even the manifest is too large.
  const render = (budgetBytes: number) => Effect.gen(function* () {
    if (byteLength(inlineManifest) > budgetBytes) {
      if (byteLength(pagedManifest) > budgetBytes) return yield* oversizedReviewInput();
      return { text: pagedManifest, hints: [deferredHint] };
    }
    let remaining = budgetBytes - byteLength(inlineManifest);
    const inlined: string[] = [];
    let deferred = 0;
    for (const range of ["scope", "full"] as const) {
      for (const { entry, patches } of items) {
        const patch = patches[range];
        if (!patch || (range === "full" && entry.shared)) continue;
        if (byteLength(patch.text) > maximumInlinePatchBytes) { deferred++; continue; }
        const section = `${entry.id} (${entry.shared ? "scope and full" : range}):\n${patch.header}${patch.text}\n`;
        const size = byteLength(section);
        if (size > remaining) { deferred++; continue; }
        inlined.push(section);
        remaining -= size;
      }
    }
    return { text: inlineManifest + inlined.join(""), hints: deferred ? [deferredHint] : [] };
  });

  // Serves one page of the JSON-lines manifest from a UTF-16 offset, ending on a whole row when one fits.
  const list = (input: unknown) => Effect.gen(function* () {
    const parsed = listDiffsInput.safeParse(input);
    if (!parsed.success) return yield* new SandboxError({ message: `Invalid list_diffs arguments. Use the returned continuation cursor and a response budget from 1024 to ${maximumPageBytes} bytes.` });
    const { cursor, maxBytes } = parsed.data;
    if (cursor > manifestRows.length || splitsSurrogate(manifestRows, cursor)) return yield* new SandboxError({ message: "Invalid catalog cursor. Use the nextCursor returned by list_diffs." });
    const response = (end: number) => JSON.stringify({ text: manifestRows.slice(cursor, end), nextCursor: end < manifestRows.length ? end : null } satisfies z.infer<typeof catalogPage>);
    let end = cursor + largestFit(Math.min(manifestRows.length - cursor, maxBytes), (length) => byteLength(response(cursor + length)) <= maxBytes);
    if (splitsSurrogate(manifestRows, end)) end--;
    const rowEnd = manifestRows.lastIndexOf("\n", end - 1) + 1;
    if (end < manifestRows.length && rowEnd > cursor) end = rowEnd;
    return response(end);
  });

  // Serves one page of a patch from a line and column cursor, continuing mid-line when a single line exceeds the budget.
  const read = (input: unknown) => Effect.gen(function* () {
    const parsed = readDiffInput.safeParse(input);
    if (!parsed.success) return yield* new SandboxError({ message: "Invalid read_diff arguments. Use a catalog ID, scope or full range, and the returned continuation cursor." });
    const { id, range, maxBytes } = parsed.data;
    const patch = items.find(({ entry }) => entry.id === id)?.patches[range];
    if (!patch) return yield* new SandboxError({ message: "This diff ID or range is unavailable. Check CHANGED FILES; full-MR context never expands review scope." });
    const { text } = patch;
    const index = linesOf(patch);
    let { line, column } = parsed.data.cursor;
    const start = index[line];
    const validCursor = start === undefined
      ? line === index.length && column === 0
      : column < start.end - start.start && !splitsSurrogate(text, start.start + column);
    if (!validCursor) return yield* new SandboxError({ message: "Invalid diff cursor. Use the nextCursor returned by read_diff." });
    const lines: z.infer<typeof diffPage>["lines"] = [];
    const response = (nextCursor: Cursor | null) => JSON.stringify({ id, range, inlineAnchors: patch.inlineAnchors, lines, nextCursor } satisfies z.infer<typeof diffPage>);
    const fits = (nextCursor: Cursor | null) => byteLength(response(nextCursor)) <= maxBytes;
    while (line < index.length) {
      const current = index[line]!;
      const offset = current.start + column;
      const fragment = { line, column, oldLine: current.oldLine, newLine: current.newLine, text: text.slice(offset, current.end) };
      lines.push(fragment);
      if (fits(line + 1 < index.length ? { line: line + 1, column: 0 } : null)) { line++; column = 0; continue; }
      // The rest of this line does not fit. Keep the longest prefix that does and stop the page there.
      let length = largestFit(Math.min(current.end - offset - 1, maxBytes), (candidate) => {
        fragment.text = text.slice(offset, offset + candidate);
        return fits({ line, column: column + candidate });
      });
      if (splitsSurrogate(text, offset + length)) length--;
      if (length === 0) { lines.pop(); break; }
      fragment.text = text.slice(offset, offset + length);
      column += length;
      break;
    }
    return response(line < index.length ? { line, column } : null);
  });

  return { entries, render, read, list };
}

export type DiffCatalog = ReturnType<typeof makeDiffCatalog>;
