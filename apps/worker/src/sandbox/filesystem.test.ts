import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { makeCheckoutFilesystem } from "./filesystem";

it("optional instruction reads distinguish absent files from unsafe and broken symlinks", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const directory = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(path.join(tmpdir(), "fred-optional-test-"))),
    (value) => Effect.promise(() => rm(value, { recursive: true, force: true })),
  );
  const checkout = path.join(directory, "checkout");
  yield* Effect.promise(() => mkdir(checkout));
  yield* Effect.promise(() => writeFile(path.join(directory, "secret"), "PRIVATE"));
  yield* Effect.promise(() => writeFile(path.join(checkout, "AGENTS.md"), "Review carefully."));
  yield* Effect.promise(() => symlink(path.join(directory, "secret"), path.join(checkout, "CLAUDE.md")));
  yield* Effect.promise(() => symlink(path.join(directory, "absent"), path.join(checkout, "REVIEW.md")));
  yield* Effect.promise(() => symlink(directory, path.join(checkout, ".ai-review")));
  const filesystem = yield* makeCheckoutFilesystem(checkout);
  expect(yield* filesystem.readOptional("AGENTS.md")).toBe("Review carefully.");
  expect(yield* filesystem.readOptional("missing.md")).toBeUndefined();
  expect(yield* filesystem.readOptional("missing/REVIEW.md")).toBeUndefined();
  for (const requested of ["CLAUDE.md", "REVIEW.md", ".ai-review/missing.md", "../missing.md"]) {
    expect((yield* filesystem.readOptional(requested).pipe(Effect.result))._tag).toBe("Failure");
  }
}))));
