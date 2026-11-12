import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { Effect, Fiber } from "effect";
import { expect, it } from "vitest";
import { makeGit } from "./index";

// A local executable exercises the process boundary without contacting GitLab.
const withExecutable = async (sha: string, use: (root: string, executable: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "fred-git-test-"));
  try {
    const executable = join(root, "fixture-git");
    await writeFile(executable, `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(join(root, "calls"))}, JSON.stringify({args:process.argv.slice(2),env:process.env})+'\\n');\nif(process.argv[2]==='rev-parse') process.stdout.write(${JSON.stringify(sha)});\n`);
    await chmod(executable, 0o700);
    await use(root, executable);
  } finally { await rm(root, { recursive: true, force: true }); }
};

it("checks out the exact SHA, keeps credentials out of arguments, and releases its directory", async () => {
  const sha = "a".repeat(40);
  await withExecutable(sha, async (root, executable) => {
    const git = makeGit({ baseUrl: "https://gitlab.internal", executable, temporaryRoot: root });
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const checkout = yield* git.checkout({ url: "https://gitlab.internal/team/repo.git", sha, token: "fixture-token" });
      expect(checkout.path.startsWith(root)).toBe(true);
    })));
    expect((await readdir(root)).filter((name) => name.startsWith("fred-review-"))).toEqual([]);
    const calls = (await readFile(join(root, "calls"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { args: string[]; env: Record<string, string> });
    expect(calls.every((call) => !call.args.some((arg) => arg.includes("fixture-token")))).toBe(true);
    expect(calls[1]?.args).toContain(sha);
    expect(calls[1]?.args).toContain("--no-recurse-submodules");
    expect(calls[0]?.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(calls[0]?.env.GIT_CONFIG_VALUE_1).toBe("false");
  });
});

it("cleans its checkout after a mismatched commit fails", async () => {
  await withExecutable("b".repeat(40), async (root, executable) => {
    const git = makeGit({ baseUrl: "https://gitlab.internal", executable, temporaryRoot: root });
    await expect(Effect.runPromise(Effect.scoped(git.checkout({ url: "https://gitlab.internal/team/repo.git", sha: "a".repeat(40), token: "fixture-token" })))).rejects.toMatchObject({ _tag: "CloneError" });
    expect((await readdir(root)).filter((name) => name.startsWith("fred-review-"))).toEqual([]);
  });
});

it("reports the failed git command with its exit status and stderr", async () => {
  const root = await mkdtemp(join(tmpdir(), "fred-git-fail-"));
  try {
    const executable = join(root, "fixture-git");
    await writeFile(executable, `#!${process.execPath}\nif(process.argv[2]==='fetch'){process.stderr.write("fatal: couldn't find remote ref\\n");process.exit(128);}\n`);
    await chmod(executable, 0o700);
    const git = makeGit({ baseUrl: "https://gitlab.internal", executable, temporaryRoot: root });
    await expect(Effect.runPromise(Effect.scoped(git.checkout({ url: "https://gitlab.internal/team/repo.git", sha: "a".repeat(40), token: "fixture-token" }))))
      .rejects.toMatchObject({ _tag: "CloneError", message: "Git fetch failed (exit 128)", stderr: "fatal: couldn't find remote ref\n" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("rejects credential URLs and abbreviated commits before launching git", async () => {
  const git = makeGit({ baseUrl: "https://gitlab.internal", executable: "/never-run" });
  await expect(Effect.runPromise(Effect.scoped(git.checkout({ url: "https://user:secret@gitlab.internal/repo.git", sha: "abc", token: "fixture-token" })))).rejects.toMatchObject({ _tag: "CloneError", message: expect.stringContaining("full commit SHA") });
});

it("interrupts an active subprocess and removes its checkout before returning", async () => {
  const root = await mkdtemp(join(tmpdir(), "fred-git-stop-"));
  const socket = join(root, "ready.sock");
  const server = createServer();
  try {
    const ready = new Promise<number>((resolve) => server.once("connection", (connection) => connection.once("data", (data) => resolve(Number(data.toString())))));
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    const executable = join(root, "fixture-git");
    await writeFile(executable, `#!${process.execPath}\nimport {connect} from 'node:net';\nconst connection=connect(${JSON.stringify(socket)},()=>connection.write(String(process.pid)));\n`);
    await chmod(executable, 0o700);
    const git = makeGit({ baseUrl: "https://gitlab.internal", executable, temporaryRoot: root });
    const fiber = Effect.runFork(Effect.scoped(git.checkout({ url: "https://gitlab.internal/repo.git", sha: "a".repeat(40), token: "fixture-token" })));
    const pid = await ready;
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(() => process.kill(pid, 0)).toThrow();
    expect((await readdir(root)).filter((name) => name.startsWith("fred-review-"))).toEqual([]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
