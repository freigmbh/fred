import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeDiffCatalog } from "../diffCatalog";
import { makeCheckoutTools, type CheckoutTools } from "./tools";
import { openWorkspace, type Workspace } from "./workspace";

describe("checkout tools with synthetic repository files", () => {
  let directory: string;
  let checkout: string;
  let tools: CheckoutTools;
  let workspace: Workspace;
  beforeEach(() => Effect.runPromise(Effect.gen(function* () {
    directory = yield* Effect.promise(() => mkdtemp(path.join(tmpdir(), "fred-sandbox-test-")));
    checkout = path.join(directory, "checkout");
    yield* Effect.promise(() => mkdir(path.join(checkout, ".git"), { recursive: true }));
    yield* Effect.promise(() => mkdir(path.join(checkout, "packages/a/.agents/skills/security"), { recursive: true }));
    yield* Effect.promise(() => writeFile(path.join(checkout, "index.ts"), "export const answer = 42;\nexport const safe = true;\n"));
    yield* Effect.promise(() => writeFile(path.join(directory, "host-secret"), "HOST_TOKEN"));
    yield* Effect.promise(() => writeFile(path.join(checkout, ".git/config"), "GITLAB_TOKEN"));
    yield* Effect.promise(() => writeFile(path.join(checkout, "packages/a/.agents/skills/security/SKILL.md"), "---\nname: security\ndescription: Review access checks\n---\nRead references.md; never execute scripts."));
    yield* Effect.promise(() => writeFile(path.join(checkout, "packages/a/.agents/skills/security/references.md"), "Check tenant boundaries."));
    yield* Effect.promise(() => symlink(path.join(directory, "host-secret"), path.join(checkout, "escape")));
    yield* Effect.promise(() => symlink(path.join(checkout, ".git"), path.join(checkout, "metadata")));
    yield* Effect.promise(() => symlink(directory, path.join(checkout, "outside")));
    workspace = yield* openWorkspace(checkout);
    tools = yield* makeCheckoutTools(workspace, makeDiffCatalog({ fullDiff: [], reviewDiff: [] }));
  })));
  afterEach(() => rm(directory, { recursive: true, force: true }));

  it("reads numbered lines and reports truncated file and search results", () => Effect.runPromise(Effect.gen(function* () {
    expect(yield* tools.execute("read", { path: "index.ts", startLine: 2, maxLines: 1 })).toContain("2: export const safe = true;");
    expect(JSON.parse(yield* tools.execute("glob", { pattern: "**/*", limit: 1 }))).toMatchObject({ total: 3, truncated: true });
    expect(JSON.parse(yield* tools.execute("grep", { query: "export", pattern: "**/*.ts", limit: 1 }))).toMatchObject({ matches: [{ path: "index.ts", line: 1 }], truncated: true });
  })));

  it.each(["../host-secret", "escape", "outside/host-secret", ".git/config", ".GIT/config", "metadata/config", "packages/a/../../../.git/config"])("denies checkout escape or metadata path %s", (requested) => Effect.runPromise(Effect.gen(function* () {
    const result = yield* tools.execute("read", { path: requested }).pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    expect(JSON.stringify(result)).not.toContain("HOST_TOKEN");
    expect(JSON.stringify(result)).not.toContain("GITLAB_TOKEN");
  })));

  it("rejects absolute paths even when the file is inside the checkout", () => Effect.runPromise(Effect.gen(function* () {
    expect((yield* tools.execute("read", { path: path.join(checkout, "index.ts") }).pipe(Effect.result))._tag).toBe("Failure");
  })));

  it("does not discover or grep metadata and symlink targets", () => Effect.runPromise(Effect.gen(function* () {
    const files = JSON.parse(yield* tools.execute("glob", { pattern: "**/*" })).files;
    expect(files).not.toContain("escape");
    expect(files).not.toContain(".git/config");
    expect(JSON.parse(yield* tools.execute("grep", { query: "TOKEN" })).matches).toEqual([]);
  })));

  it("loads nested skills and references while missing names produce a reusable hint", () => Effect.runPromise(Effect.gen(function* () {
    expect(yield* tools.execute("list_skills", {})).toContain("security");
    expect(yield* tools.execute("load_skill", { name: "security" })).toContain("Read references.md");
    expect(yield* tools.execute("read", { path: "packages/a/.agents/skills/security/references.md" })).toContain("Check tenant boundaries");
    const hint = yield* tools.execute("load_skill", { name: "missing" });
    expect(hint).toContain("Continue the review without it");
    yield* tools.execute("load_skill", { name: "missing" });
    expect(workspace.skills.hints).toEqual([hint]);
  })));

  it("rejects unsupported tools and malformed arguments without running an operation", () => Effect.runPromise(Effect.gen(function* () {
    expect((yield* tools.execute("exec_command", { cmd: "echo unsafe" }).pipe(Effect.result))._tag).toBe("Failure");
    expect((yield* tools.execute("read", { path: "index.ts", maxLines: -1 }).pipe(Effect.result))._tag).toBe("Failure");
  })));
});
