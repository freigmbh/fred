import { Effect } from "effect";
import type { z } from "zod";
import { GitLabError } from "../errors";
import { formatPaths } from "./formatPaths";
import { pathForms, recoverDiff } from "./rawDiff";
import type { Diff, treeEntry } from "./schemas";

type TreeEntry = z.infer<typeof treeEntry>;

export const incompleteMrDiff = (condition: string, paths: string[] = [], cause?: unknown) => new GitLabError({
  message: `Complete MR diff unavailable: ${condition}; paths: ${formatPaths(paths)}`,
  diagnostic: { category: "gitlab", code: "diff_recovery_failed" },
  ...(cause === undefined ? {} : { cause }),
});

export const cappedLowerBound = (count = "") => {
  const bound = Number(count.slice(0, -1));
  return /^[1-9]\d*\+$/.test(count) && Number.isSafeInteger(bound) ? bound : undefined;
};

const indexTree = (entries: TreeEntry[]) => Effect.gen(function* () {
  const tree = new Map<string, TreeEntry>();
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.path)) return yield* Effect.fail(incompleteMrDiff("duplicate repository tree entry", [entry.path]));
    seen.add(entry.path);
    if (entry.type !== "tree") tree.set(entry.path, entry);
  }
  return tree;
});

const changedSides = (base: Map<string, TreeEntry>, head: Map<string, TreeEntry>) => {
  const changed = [...new Set([...base.keys(), ...head.keys()])].filter((path) => {
    const before = base.get(path);
    const after = head.get(path);
    return before?.id !== after?.id || before?.mode !== after?.mode;
  });
  return { oldPaths: new Set(changed.filter((path) => base.has(path))), newPaths: new Set(changed.filter((path) => head.has(path))) };
};

const renameHeaders = (section: string) => {
  const headers = section.split(/^--- |^@@ /m, 1)[0] ?? "";
  const from = /^rename from (.*)$/m.exec(headers)?.[1];
  const to = /^rename to (.*)$/m.exec(headers)?.[1];
  return from !== undefined && to !== undefined ? { from, to } : undefined;
};

export const recoverCappedDiff = (apiFiles: Diff[], baseEntries: TreeEntry[], headEntries: TreeEntry[], raw: string) => Effect.gen(function* () {
  const base = yield* indexTree(baseEntries);
  const head = yield* indexTree(headEntries);
  const { oldPaths, newPaths } = changedSides(base, head);
  const files: Diff[] = [];
  const claim = (file: Diff) => Effect.gen(function* () {
    const claimed = (file.new_file || oldPaths.delete(file.old_path)) && (file.deleted_file || newPaths.delete(file.new_path));
    if (!claimed) return yield* Effect.fail(incompleteMrDiff("diff entry disagrees with repository trees", [file.old_path, file.new_path]));
    files.push(file);
  });
  for (const file of apiFiles) yield* claim(file);

  const oldNames = new Map([...oldPaths].flatMap((path) => pathForms(path).map((name) => [name, path] as const)));
  const newNames = new Map([...newPaths].flatMap((path) => pathForms(path).map((name) => [name, path] as const)));
  for (const section of raw.split(/(?=^diff --git )/m)) {
    const rename = renameHeaders(section);
    const oldPath = rename && oldNames.get(rename.from);
    const newPath = rename && newNames.get(rename.to);
    if (oldPath !== undefined && newPath !== undefined) {
      yield* claim({ old_path: oldPath, new_path: newPath, diff: "", new_file: false, deleted_file: false, renamed_file: true });
    }
  }
  for (const path of new Set([...oldPaths, ...newPaths])) {
    files.push({ old_path: path, new_path: path, diff: "", new_file: !oldPaths.has(path), deleted_file: !newPaths.has(path), renamed_file: false });
  }
  const recovered = yield* recoverDiff(files, raw);
  return recovered.map((file, index) => index < apiFiles.length ? file : { ...file, recovery: file.recovery ?? { context: file.diff } });
});
