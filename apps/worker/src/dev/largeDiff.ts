import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer } from "effect";
import { CloneError } from "../errors";
import { Git } from "../git";
import type { ReviewContext } from "../reviewInput";

type Diff = ReviewContext["fullDiff"][number];
const migrationComment = `/* Migration record: ${"0123456789abcdef".repeat(2560)} */`;
const counterHead = `${migrationComment}\nexport function counter(input: number | undefined) {\n  return input || 1;\n}\n`;
const deletedSource = `${migrationComment}\nexport function assertAvailable(available: number, requested: number) {\n  if (requested > available) throw new Error("Insufficient stock");\n}\n`;
const addedDiff = (path: string, content: string): Diff => {
  const lines = content.trimEnd().split("\n");
  return {
    old_path: path, new_path: path, new_file: true, renamed_file: false, deleted_file: false,
    diff: `@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}\n`,
  };
};
const counterDiff = (oldDefault: number): Diff => ({
  old_path: "src/counter.ts", new_path: "src/counter.ts", new_file: false, renamed_file: false, deleted_file: false,
  diff: `@@ -1,4 +1,4 @@\n ${migrationComment}\n export function counter(input: number | undefined) {\n-  return input ?? ${oldDefault};\n+  return input || 1;\n }\n`,
});
const deletion: Diff = {
  old_path: "src/assertAvailable.ts", new_path: "src/assertAvailable.ts", new_file: false, renamed_file: false, deleted_file: true,
  diff: `@@ -1,4 +0,0 @@\n${deletedSource.trimEnd().split("\n").map((line) => `-${line}`).join("\n")}\n`,
};

export const largeDiffOutput = {
  detect: { candidates: [
    { file: "src/counter.ts", line: 3, severity: "should_fix", title: "Preserve a zero input", body: "An input of zero is replaced with one. Use nullish coalescing so zero remains zero." },
    { file: "src/assertAvailable.ts", oldLine: 2, severity: "blocking", title: "Keep the stock assertion module available to its caller", body: "src/reserve.ts still imports assertAvailable from this deleted module, so TypeScript cannot resolve the module and the reservation code cannot build." },
  ] },
  validate: { verdicts: [{ index: 0, verdict: "accepted" }, { index: 1, verdict: "accepted" }], findingDecisions: [] },
};

export function largeDiffFixture(base: ReviewContext) {
  const assets = [
    { path: "assets/bee.obj", content: "v 0.000001 0.000002 0.000003\n".repeat(320_000) },
    { path: "assets/flight.csv", content: "1,0.000001,0.000002,0.000003\n".repeat(320_000) },
    ...Array.from({ length: 649 }, (_, index) => ({ path: `assets/${"imported/simulation/resources/flight-trajectories/generated/reference/catalog/".repeat(4)}${String(index).padStart(3, "0")}.json`, content: `${JSON.stringify({ index, units: "metres", enabled: true })}\n` })),
  ];
  const context: ReviewContext = {
    ...base, title: "Import generated assets and update stock calculations", description: "Synthetic large merge request. Asset imports are previous changes; this incremental review changes the counter and removes the stock assertion module.",
    reviewBaseSha: "c".repeat(40), fullDiff: [...assets.map(({ path, content }) => addedDiff(path, content)), counterDiff(2), deletion],
    reviewDiff: [counterDiff(1), deletion],
  };
  const populate = (path: string) => Effect.tryPromise({
    try: async () => {
      await cp(fileURLToPath(new URL("../../../../fixtures/review-repos/large-diff", import.meta.url)), path, { recursive: true });
      await writeFile(join(path, "src/counter.ts"), counterHead);
      for (const asset of assets) {
        const destination = join(path, asset.path);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, asset.content);
      }
    },
    catch: () => new CloneError({ message: "Cannot populate large-diff fixture checkout" }),
  });
  const git = Layer.succeed(Git, { checkout: () => Effect.acquireRelease(
    Effect.tryPromise({ try: () => mkdtemp(join(tmpdir(), "fred-large-diff-")), catch: () => new CloneError({ message: "Cannot create large-diff fixture checkout" }) }),
    (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
  ).pipe(Effect.tap(populate), Effect.map((path) => ({ path }))) });
  return { context, git };
}
