import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import splitRename from "../../../../fixtures/gitlab/synthetic-split-rename.json";
import nonTextRenames from "../../../../fixtures/gitlab/synthetic-nontext-split-renames.json";
import hunkless from "../../../../fixtures/gitlab/synthetic-hunkless-sections.json";
import omittedRename from "../../../../fixtures/gitlab/synthetic-omitted-split-rename.json";
import { recoverDiff } from "./rawDiff";

const file = { old_path: "src/generated.ts", new_path: "src/generated.ts", diff: "", new_file: false, renamed_file: false, deleted_file: false };
const patch = "@@ -1 +1 @@\n-old\n+new\n";
const raw = `diff --git a/src/generated.ts b/src/generated.ts\nindex 1234567..abcdef0 100644\n--- a/src/generated.ts\n+++ b/src/generated.ts\n${patch}`;

describe("raw diff recovery", () => {
  const completeNonText = splitRename.diffs.map((entry) => entry.renamed_file ? { ...entry, diff: "", too_large: false, collapsed: false } : entry);

  it.each(nonTextRenames)("preserves complete $kind renames alongside omitted text patches", async ({ deletion, addition }) => {
    const recovered = await Effect.runPromise(recoverDiff(completeNonText, deletion + addition + splitRename.lockfile));
    expect(recovered[0]).toBe(completeNonText[0]);
    expect(recovered[1]?.diff).toBe(patch);
  });

  it.each(nonTextRenames)("stands in for an omitted rename patch with verified $kind halves", async ({ deletion, addition }) => {
    const ambiguous = splitRename.diffs.map((entry) => ({ ...entry, diff: "" }));
    const recovered = await Effect.runPromise(recoverDiff(ambiguous, deletion + addition + splitRename.lockfile));
    expect(recovered[0]).toMatchObject({ diff: "", too_large: false, collapsed: false, recovery: { hint: expect.stringContaining("summary only") } });
    expect(recovered[0]?.recovery?.context).toContain(deletion.split("\n")[2]);
    expect(recovered[1]?.diff).toBe(patch);
  });

  it.each(nonTextRenames.flatMap((entry) => [
    { name: `${entry.kind} missing index`, ...entry, deletion: entry.deletion.replace(/^index .*\n/m, "") },
    { name: `${entry.kind} wrong absent side`, ...entry, addition: entry.addition.replace("0000000..", "1234567..") },
    { name: `${entry.kind} missing mode`, ...entry, addition: entry.addition.replace("new file mode 100755\n", "") },
    { name: `${entry.kind} trailing text`, ...entry, addition: entry.addition + "unexpected\n" },
  ]))("rejects malformed non-text halves: $name", async ({ deletion, addition }) => {
    const error = await Effect.runPromise(recoverDiff(completeNonText, deletion + addition + splitRename.lockfile).pipe(Effect.flip));
    expect(error._tag).toBe("GitLabError");
  });

  it.each([
    "index 1234567..0000000\n",
    "index e69de29..0000000\n--- a/old.ts\n+++ /dev/null\n",
    "index b835d73..0000000\nBinary files a/other.ts and /dev/null differ\n",
    "index b835d73..0000000\nBinary files /dev/null and b/old.ts differ\n",
  ])("rejects a truncated or path-mismatched non-text deletion %#", async (body) => {
    const deletion = "diff --git a/old.ts b/old.ts\ndeleted file mode 100644\n" + body;
    const error = await Effect.runPromise(recoverDiff(completeNonText, deletion + splitRename.addition + splitRename.lockfile).pipe(Effect.flip));
    expect(error._tag).toBe("GitLabError");
  });

  it.each([
    splitRename.deletion + splitRename.addition + splitRename.lockfile,
    splitRename.lockfile + splitRename.addition + splitRename.deletion,
  ])("preserves a complete rename when raw sections split it, regardless of order", async (input) => {
    const recovered = await Effect.runPromise(recoverDiff(splitRename.diffs, input));
    expect(recovered).toHaveLength(2);
    expect(recovered[0]).toBe(splitRename.diffs[0]);
    expect(recovered[1]).toEqual({ ...splitRename.diffs[1], diff: patch, too_large: false, collapsed: false });
  });

  it.each([
    ["missing deletion", splitRename.addition],
    ["missing addition", splitRename.deletion],
    ["duplicate deletion", splitRename.deletion + splitRename.deletion + splitRename.addition],
    ["duplicate addition", splitRename.deletion + splitRename.addition + splitRename.addition],
    ["mixed representations", "diff --git a/old.ts b/new.ts\n" + splitRename.deletion + splitRename.addition],
    ["wrong deletion path", splitRename.deletion.replace("--- a/old.ts", "--- a/other.ts") + splitRename.addition],
    ["not a deletion", splitRename.deletion.replace("+++ /dev/null", "+++ b/old.ts") + splitRename.addition],
    ["not an addition", splitRename.deletion + splitRename.addition.replace("--- /dev/null", "--- a/new.ts")],
    ["missing mode", splitRename.deletion.replace("deleted file mode 100644\n", "") + splitRename.addition],
    ["truncated deletion", splitRename.deletion.replace("-old\n", "") + splitRename.addition],
    ["truncated addition", splitRename.deletion + splitRename.addition.replace("+new\n", "")],
    ["partial deletion", splitRename.deletion.replace("-1,2", "-2,2") + splitRename.addition],
    ["partial addition", splitRename.deletion + splitRename.addition.replace("+1,2", "+2,2")],
    ["unexpected file", splitRename.deletion + splitRename.addition + "diff --git a/other.ts b/other.ts\n"],
  ])("rejects invalid split rename coverage: %s", async (_name, input) => {
    const error = await Effect.runPromise(recoverDiff(splitRename.diffs, input + splitRename.lockfile).pipe(Effect.flip));
    expect(error).toMatchObject({ _tag: "GitLabError", diagnostic: { category: "gitlab", code: "diff_recovery_failed" } });
  });

  it.each([
    ["text halves with CRLF and no final newline", omittedRename.deletion],
    ["an empty deletion and a text addition", omittedRename.emptyDeletion],
  ])("stands in for an omitted split rename patch with %s", async (_name, deletion) => {
    const recovered = await Effect.runPromise(recoverDiff(omittedRename.diffs, deletion + omittedRename.addition + omittedRename.lockfile));
    expect(recovered[0]).toEqual({ ...omittedRename.diffs[0], too_large: false, collapsed: false, recovery: {
      context: `GitLab omitted this rename's patch. The verified deletion and addition sections below show the complete old and new text; unchanged lines appear in both.\n${deletion}${omittedRename.addition.slice(0, -1)}`,
      hint: 'GitLab omitted the rename patch for `"old.ts"` to `"new.ts"`; its findings appear in the summary only.',
    } });
    expect(recovered[1]).toBe(omittedRename.diffs[1]);
  });

  it.each([
    ["truncated deletion", omittedRename.deletion.replace("-last\n", "") + omittedRename.addition],
    ["missing addition", omittedRename.deletion],
    ["unsupported deletion mode", omittedRename.deletion.replace("deleted file mode 100644", "deleted file mode 000000") + omittedRename.addition],
    ["partial deletion", omittedRename.deletion.replace("-1,2", "-2,2") + omittedRename.addition],
  ])("still rejects invalid halves behind an omitted rename patch: %s", async (_name, halves) => {
    const error = await Effect.runPromise(recoverDiff(omittedRename.diffs, halves + omittedRename.lockfile).pipe(Effect.flip));
    expect(error).toMatchObject({ _tag: "GitLabError", diagnostic: { code: "diff_recovery_failed" } });
  });

  it.each(hunkless.accepted)("accepts a verified hunk-less section: $name", async ({ file, raw }) => {
    const recovered = await Effect.runPromise(recoverDiff([file], raw));
    expect(recovered[0]).toEqual({ ...file, too_large: false, collapsed: false, recovery: { context: raw.slice(raw.indexOf("\n") + 1, -1) } });
  });

  it.each(hunkless.rejected)("rejects an unverifiable hunk-less section: $name", async ({ file, raw }) => {
    const error = await Effect.runPromise(recoverDiff([file], raw).pipe(Effect.flip));
    expect(error).toMatchObject({ _tag: "GitLabError", diagnostic: { code: "diff_recovery_failed" } });
    expect(error.message).toContain(file.new_path);
  });

  it("leaves a complete API entry alone when its raw section has no hunks", async () => {
    const complete = { ...file, old_path: "run.sh", new_path: "run.sh", diff: "@@ -1 +1 @@\n-old\n+new\n" };
    const recovered = await Effect.runPromise(recoverDiff([complete], "diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n"));
    expect(recovered[0]).toBe(complete);
  });

  it("rejects ambiguous ownership of a rename's raw sections", async () => {
    const collision = { ...file, old_path: "old.ts", new_path: "old.ts", diff: patch };
    const error = await Effect.runPromise(recoverDiff([...splitRename.diffs, collision], splitRename.deletion + splitRename.addition + splitRename.lockfile).pipe(Effect.flip));
    expect(error.message).toContain("ambiguous file headers");
  });

  it("allows canonical rename sections even when their unused split alternatives overlap", async () => {
    const files = [
      { ...file, old_path: "first.ts", new_path: "second.ts", renamed_file: true, diff: patch },
      { ...file, old_path: "second.ts", new_path: "third.ts", renamed_file: true, diff: patch },
      file,
    ];
    const input = "diff --git a/first.ts b/second.ts\nrename from first.ts\nrename to second.ts\ndiff --git a/second.ts b/third.ts\nrename from second.ts\nrename to third.ts\n" + raw;
    const recovered = await Effect.runPromise(recoverDiff(files, input));
    expect(recovered.slice(0, 2)).toEqual(files.slice(0, 2));
    expect(recovered[2]?.diff).toBe(patch);
  });

  it.each([{ too_large: true }, { collapsed: true }, {}])("recovers omitted patch metadata %j", async (flags) => {
    expect(await Effect.runPromise(recoverDiff([{ ...file, ...flags }], raw))).toEqual([
      { ...file, diff: patch, too_large: false, collapsed: false },
    ]);
  });

  it("requires raw coverage for complete regular files as well", async () => {
    const complete = { ...file, old_path: "other.ts", new_path: "other.ts", diff: patch };
    const error = await Effect.runPromise(recoverDiff([file, complete], raw).pipe(Effect.flip));
    expect(error.message).toContain("missing file sections");
    expect(error.message).toContain("other.ts");
  });

  it("preserves complete regular patches and their order when raw sections are reordered", async () => {
    const complete = { ...file, old_path: "other.ts", new_path: "other.ts", diff: patch };
    const recovered = await Effect.runPromise(recoverDiff([complete, file], raw + raw.replaceAll("src/generated.ts", "other.ts")));
    expect(recovered[0]).toBe(complete);
    expect(recovered[1]?.diff).toBe(patch);
  });

  it.each([
    ["space name.ts", "a/space name.ts", "b/space name.ts"],
    ["tab\tname.ts", '"a/tab\\tname.ts"', '"b/tab\\tname.ts"'],
    ["ä\tname.ts", '\"a/ä\\tname.ts\"', '\"b/ä\\tname.ts\"'],
    ["ä.ts", '"a/\\303\\244.ts"', '"b/\\303\\244.ts"'],
    ['quote".ts', '"a/quote\\\".ts"', '"b/quote\\\".ts"'],
  ])("matches Git path quoting for %s", async (path, oldPath, newPath) => {
    const suffix = path.includes(" ") ? "\t" : "";
    const input = `diff --git ${oldPath} ${newPath}\n--- ${oldPath}${suffix}\n+++ ${newPath}${suffix}\n${patch}`;
    const recovered = await Effect.runPromise(recoverDiff([{ ...file, old_path: path, new_path: path }], input));
    expect(recovered[0]?.diff).toBe(patch);
  });

  it.each([
    [{ new_file: true }, "/dev/null", "b/src/generated.ts", "@@ -0,0 +1 @@\n+new\n"],
    [{ deleted_file: true }, "a/src/generated.ts", "/dev/null", "@@ -1 +0,0 @@\n-old\n"],
  ])("recovers additions and deletions: %j", async (flags, oldPath, newPath, body) => {
    const input = `diff --git a/src/generated.ts b/src/generated.ts\n--- ${oldPath}\n+++ ${newPath}\n${body}`;
    const recovered = await Effect.runPromise(recoverDiff([{ ...file, ...flags }], input));
    expect(recovered[0]?.diff).toBe(body);
  });

  it("retains multiple hunks, CRLF source lines, and no-newline markers", async () => {
    const body = "@@ -1 +1 @@\n-old\r\n+new\r\n@@ -8 +8 @@\n-last\n\\ No newline at end of file\n+next\n\\ No newline at end of file\n";
    const recovered = await Effect.runPromise(recoverDiff([file], raw.replace(patch, body)));
    expect(recovered[0]?.diff).toBe(body);
  });

  it.each([
    raw.slice(0, -2),
    raw.replace("--- a/src/generated.ts", "--- a/other.ts"),
    raw.replace(patch, "@@ -1,2 +1 @@\n-old\n+new\n"),
    raw.replace(patch, patch + "+extra\n"),
    raw.replace(patch, patch + "@@ -8 +8 @@\n-old\n"),
    raw.replace(patch, ""),
  ])("rejects mismatched paths or incomplete text patches %#", async (input) => {
    const error = await Effect.runPromise(recoverDiff([file], input).pipe(Effect.flip));
    expect(error.message).toContain("src/generated.ts");
    expect(error._tag).toBe("GitLabError");
  });
});
