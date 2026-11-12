import { Effect } from "effect";
import { GitLabError } from "../errors";
import type { ReviewFile } from "../reviewInput";
import { formatPaths } from "./formatPaths";
import type { Diff } from "./schemas";

export const incompleteDiff = (file: Diff) => file.too_large || file.collapsed || (file.diff === "" && (file.too_large === undefined || file.collapsed === undefined));

const fail = (condition: string, paths: string[]) => Effect.fail(new GitLabError({
  message: `Raw diff recovery failed: ${condition}; paths: ${formatPaths(paths)}`,
  diagnostic: { category: "gitlab", code: "diff_recovery_failed" },
}));

// Quotes a path the way Git prints it in diff headers: C escapes for control, quote, backslash, and non-ASCII bytes.
const quotedPath = (path: string, quoteNonAscii = true) => {
  const escapes: Record<number, string> = { 7: "\\a", 8: "\\b", 9: "\\t", 10: "\\n", 11: "\\v", 12: "\\f", 13: "\\r", 34: '\\"', 92: "\\\\" };
  let escaped = "";
  for (const character of path) {
    const code = character.charCodeAt(0);
    const needsOctal = code < 32 || code === 127 || (quoteNonAscii && code > 127);
    escaped += escapes[code] ?? (needsOctal
      ? [...Buffer.from(character)].map((byte) => `\\${byte.toString(8).padStart(3, "0")}`).join("")
      : character);
  }
  return escaped === path ? path : `"${escaped}"`;
};

export const pathForms = (path: string) => [...new Set([path, quotedPath(path), quotedPath(path, false)])];
const headersFor = (file: Diff) => pathForms(`a/${file.old_path}`).flatMap((oldPath) => pathForms(`b/${file.new_path}`).map((newPath) => `diff --git ${oldPath} ${newPath}`));
const isHunk = (line: string) => line.startsWith("@@ ");

const completeHunks = (patch: string) => {
  const lines = patch.split("\n");
  if (lines.at(-1) === "") lines.pop();
  let oldRemaining = 0;
  let newRemaining = 0;
  let hunks = 0;
  for (const line of lines) {
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      if (oldRemaining || newRemaining) return false;
      oldRemaining = Number(hunk[1] ?? 1);
      newRemaining = Number(hunk[2] ?? 1);
      hunks++;
      continue;
    }
    if (hunks === 0) return false;
    if (line === "\\ No newline at end of file") continue;
    if (line.startsWith(" ")) { oldRemaining--; newRemaining--; }
    else if (line.startsWith("-")) oldRemaining--;
    else if (line.startsWith("+")) newRemaining--;
    else return false;
    if (oldRemaining < 0 || newRemaining < 0) return false;
  }
  return hunks > 0 && oldRemaining === 0 && newRemaining === 0;
};

const recoverPatch = (file: Diff, lines: string[]) => Effect.gen(function* () {
  const hunkStart = lines.findIndex(isHunk);
  // Git appends a tab to --- and +++ markers when the path contains spaces.
  const marker = (offset: number) => lines[hunkStart - offset]?.replace(/\t$/, "") ?? "";
  const oldMarkers = pathForms(file.new_file ? "/dev/null" : `a/${file.old_path}`).map((path) => `--- ${path}`);
  const newMarkers = pathForms(file.deleted_file ? "/dev/null" : `b/${file.new_path}`).map((path) => `+++ ${path}`);
  if (hunkStart < 2 || !oldMarkers.includes(marker(2)) || !newMarkers.includes(marker(1))) {
    return yield* fail("missing text patch or mismatched patch paths", [file.old_path, file.new_path]);
  }
  const patch = lines.slice(hunkStart).join("\n");
  if (!completeHunks(patch)) return yield* fail("incomplete or malformed hunks", [file.new_path]);
  return { ...file, diff: patch, too_large: false, collapsed: false };
});

const emptyBlobSha = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
const fileModes = ["100644", "100755"];
// Every mode Git prints for a tree entry: regular file, executable, symlink, gitlink.
const gitMode = "(?:100644|100755|120000|160000)";
const zeroBlob = (blob: string) => /^0+$/.test(blob);

// Git's extended header lines for a section without text hunks, in the fixed order Git prints them.
const metadataPattern = new RegExp([
  `^(?:old mode (?<oldMode>${gitMode})\\nnew mode (?<newMode>${gitMode})\\n)?`,
  "(?:similarity index (?<similarity>\\d{1,3})%\\nrename from (?<renameFrom>[^\\n]*)\\nrename to (?<renameTo>[^\\n]*)\\n)?",
  `(?:(?<fileMode>new|deleted) file mode ${gitMode}\\n)?`,
  `(?:index (?<oldBlob>[0-9a-f]{7,40})\\.\\.(?<newBlob>[0-9a-f]{7,40})(?: (?<indexMode>${gitMode}))?\\n)?`,
  "(?:Binary files (?<binary>[^\\n]*) differ\\n)?$",
].join(""));

// True when parsed hunk-less headers describe the API entry's change: an unchanged rename, an empty file addition or deletion, a mode-only change, or a binary change.
const metadataAgrees = (file: Diff, groups: Record<string, string | undefined>) => {
  const { oldMode, newMode, similarity, renameFrom, renameTo, fileMode, oldBlob, newBlob, indexMode, binary } = groups;
  const flags = [file.renamed_file, file.new_file, file.deleted_file].filter(Boolean).length;
  const samePath = file.old_path === file.new_path;
  const modeChange = oldMode !== undefined;
  const oldSide = file.new_file ? "/dev/null" : `a/${file.old_path}`;
  const newSide = file.deleted_file ? "/dev/null" : `b/${file.new_path}`;
  // Git does not quote spaces, so the marker is matched whole instead of split on " and ".
  const binaryMarker = pathForms(oldSide).some((oldPath) => pathForms(newSide).some((newPath) => binary === `${oldPath} and ${newPath}`));
  const renameLines = renameFrom !== undefined && pathForms(file.old_path).includes(renameFrom) && pathForms(file.new_path).includes(renameTo ?? "");
  // At most one API flag, and only a rename changes the path.
  if (flags > 1 || samePath === file.renamed_file) return false;
  if (modeChange && (oldMode === newMode || ![oldMode, newMode].every((mode) => fileModes.includes(mode ?? "")))) return false;
  if (fileMode !== (file.new_file ? "new" : file.deleted_file ? "deleted" : undefined)) return false;
  if (file.renamed_file ? !renameLines : renameFrom !== undefined) return false;
  // Git omits the index line only for an unchanged rename or a mode-only change.
  if (oldBlob === undefined || newBlob === undefined) {
    return binary === undefined && (file.renamed_file ? Number(similarity) === 100 : modeChange && flags === 0);
  }
  if (file.new_file || file.deleted_file) {
    const [present, absent] = file.new_file ? [newBlob, oldBlob] : [oldBlob, newBlob];
    return !modeChange && indexMode === undefined && zeroBlob(absent) && !zeroBlob(present) && (emptyBlobSha.startsWith(present) ? binary === undefined : binaryMarker);
  }
  // Git prints the index mode suffix only when both sides share a mode.
  return !zeroBlob(oldBlob) && !zeroBlob(newBlob) && oldBlob !== newBlob && (indexMode === undefined) === modeChange && binaryMarker && (!file.renamed_file || Number(similarity) < 100);
};

// Recovers an omitted API patch from a hunk-less raw section. Fails unless the section is complete and its headers agree with the API flags and paths.
const recoverMetadata = (file: Diff, lines: string[]) => Effect.gen(function* () {
  const context = lines.join("\n");
  const groups = metadataPattern.exec(context)?.groups;
  if (!groups || !metadataAgrees(file, groups)) return yield* fail("unverifiable empty patch", [file.old_path, file.new_path]);
  return { ...file, too_large: false, collapsed: false, recovery: { context: context.slice(0, -1) } };
});

type RenameHalf = "deletion" | "addition";
type SectionKind = "regular" | RenameHalf;
type Sections = Partial<Record<SectionKind, string[]>>;

const renameHalf = (file: Diff, kind: RenameHalf): Diff => kind === "deletion"
  ? { ...file, new_path: file.old_path, renamed_file: false, new_file: false, deleted_file: true }
  : { ...file, old_path: file.new_path, renamed_file: false, new_file: true, deleted_file: false };

const sectionVariants = (file: Diff): { kind: SectionKind; file: Diff }[] => [
  { kind: "regular", file },
  ...(file.renamed_file && file.old_path !== file.new_path
    ? (["deletion", "addition"] as const).map((kind) => ({ kind, file: renameHalf(file, kind) }))
    : []),
];

const completeNonTextHalf = (file: Diff, kind: RenameHalf, lines: string[]) => {
  const index = /^index ([a-f0-9]{7,40})\.\.([a-f0-9]{7,40})$/.exec(lines[1] ?? "");
  if (!index) return false;
  const blob = index[kind === "deletion" ? 1 : 2] ?? "";
  const absent = index[kind === "deletion" ? 2 : 1] ?? "";
  if (!zeroBlob(absent) || zeroBlob(blob) || lines.at(-1) !== "") return false;
  if (lines.length === 3) return emptyBlobSha.startsWith(blob);
  if (lines.length !== 4) return false;
  const path = kind === "deletion" ? `a/${file.old_path}` : `b/${file.new_path}`;
  return pathForms(path).some((path) => lines[2] === (kind === "deletion"
    ? `Binary files ${path} and /dev/null differ`
    : `Binary files /dev/null and ${path} differ`));
};

const validateRenameHalf = (file: Diff, kind: RenameHalf, lines: string[]) => Effect.gen(function* () {
  const half = renameHalf(file, kind);
  const mode = new RegExp(`^${kind === "deletion" ? "deleted" : "new"} file mode ${gitMode}$`);
  if (!mode.test(lines[0] ?? "")) return yield* fail("invalid rename deletion or addition", [half.old_path, half.new_path]);
  if (completeNonTextHalf(file, kind, lines)) return;
  const { diff } = yield* recoverPatch(half, lines);
  const wholeFile = kind === "deletion" ? /^@@ -1(?:,[1-9]\d*)? \+0,0 @@(?: .*)?$/ : /^@@ -0,0 \+1(?:,[1-9]\d*)? @@(?: .*)?$/;
  const hunks = diff.split("\n").filter(isHunk);
  if (hunks.length !== 1 || !wholeFile.test(hunks[0] ?? "")) {
    return yield* fail("invalid rename deletion or addition", [half.old_path, half.new_path]);
  }
});

// Builds the review entry for an omitted rename patch from both verified halves. Their line numbers are not GitLab's, so the entry gets no inline anchors.
const splitRenameFallback = (file: Diff, deletion: string[], addition: string[]): ReviewFile => ({
  ...file, diff: "", too_large: false, collapsed: false,
  recovery: {
    context: [
      "GitLab omitted this rename's patch. The verified deletion and addition sections below show the complete old and new text; unchanged lines appear in both.",
      `diff --git a/${file.old_path} b/${file.old_path}`, ...deletion.slice(0, -1),
      `diff --git a/${file.new_path} b/${file.new_path}`, ...addition.slice(0, -1),
    ].join("\n"),
    hint: `GitLab omitted the rename patch for ${formatPaths([file.old_path])} to ${formatPaths([file.new_path])}; its findings appear in the summary only.`,
  },
});

const recoverFile = (file: Diff, { regular, deletion, addition }: Sections): Effect.Effect<ReviewFile, GitLabError> => Effect.gen(function* () {
  if (regular) {
    if (deletion || addition) return yield* fail("mixed rename representations", [file.old_path, file.new_path]);
    if (!incompleteDiff(file)) return file;
    return regular.some(isHunk) ? yield* recoverPatch(file, regular) : yield* recoverMetadata(file, regular);
  }
  if (!deletion || !addition) return yield* fail("missing file sections", [file.old_path, file.new_path]);
  yield* validateRenameHalf(file, "deletion", deletion);
  yield* validateRenameHalf(file, "addition", addition);
  return incompleteDiff(file) ? splitRenameFallback(file, deletion, addition) : file;
});

export const recoverDiff = (files: Diff[], raw: string) => Effect.gen(function* () {
  if (raw !== "" && !raw.endsWith("\n")) return yield* fail("unterminated raw diff response", files.filter(incompleteDiff).map((file) => file.new_path));
  const owners = new Map<string, { file: Diff; kind: SectionKind } | null>();
  for (const file of files) {
    for (const variant of sectionVariants(file)) {
      for (const header of headersFor(variant.file)) owners.set(header, owners.has(header) ? null : { file, kind: variant.kind });
    }
  }
  const sections = new Map<Diff, Sections>();
  for (const section of raw.split(/(?=^diff --git )/m)) {
    const [header = "", ...lines] = section.split("\n");
    const owner = owners.get(header);
    if (owner === null) return yield* fail("ambiguous file headers", [header]);
    if (!owner) return yield* fail("unexpected or malformed file section", [header, ...files.filter(incompleteDiff).map((entry) => entry.new_path)]);
    const parts = sections.get(owner.file) ?? {};
    if (parts[owner.kind]) return yield* fail("duplicate file section", [owner.file.new_path]);
    parts[owner.kind] = lines;
    sections.set(owner.file, parts);
  }
  return yield* Effect.forEach(files, (file) => recoverFile(file, sections.get(file) ?? {}));
});
