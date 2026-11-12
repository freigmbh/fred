import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import { SandboxError } from "../errors";

export const maximumFileBytes = 2 * 1024 * 1024;
const maximumFiles = 100_000;

const io = <A>(message: string, operation: () => Promise<A>) =>
  Effect.tryPromise({ try: operation, catch: (cause) => new SandboxError({ message, cause }) });

const isMissing = (error: SandboxError) =>
  typeof error.cause === "object" && error.cause !== null && "code" in error.cause && error.cause.code === "ENOENT";

const outsideCheckout = (root: string, resolved: string) => {
  const relative = path.relative(root, resolved);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || relative.split(path.sep).some((part) => part.toLowerCase() === ".git");
};

// Rejects metadata and paths outside the checkout before any file is opened.
const checkedPath = (root: string, requested: string) => Effect.gen(function* () {
  if (path.isAbsolute(requested) || requested.includes("\\") || requested.split("/").some((part) => part.toLowerCase() === ".git")) {
    return yield* new SandboxError({ message: "Use a checkout-relative path outside .git." });
  }
  const absolute = path.resolve(root, requested);
  if (outsideCheckout(root, absolute)) {
    return yield* new SandboxError({ message: "Path is outside the permitted checkout files." });
  }
  let resolved = root;
  for (const component of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
    const candidate = path.join(resolved, component);
    const entry = yield* io("File does not exist or is unavailable in the checkout. Use glob to locate it; continue without unavailable skill references.", () => lstat(candidate));
    resolved = yield* io("Cannot resolve checkout file.", () => realpath(candidate)).pipe(Effect.catch((error) =>
      entry.isSymbolicLink() && isMissing(error)
        ? Effect.fail(new SandboxError({ message: "Path contains a broken symbolic link; repair the repository reference." }))
        : Effect.fail(error),
    ));
    if (outsideCheckout(root, resolved)) return yield* new SandboxError({ message: "Path is outside the permitted checkout files." });
  }
  return resolved;
});

// Lists every checkout file up front and serves bounded, confined reads of them. Open it through openWorkspace, once per job.
export const makeCheckoutFilesystem = (checkoutPath: string) => Effect.gen(function* () {
  const root = yield* io("Checkout is unavailable.", () => realpath(checkoutPath));
  const rootInfo = yield* io("Checkout is unavailable.", () => stat(root));
  if (!rootInfo.isDirectory()) return yield* new SandboxError({ message: "Checkout must be a directory." });

  const read = (requested: string) => Effect.gen(function* () {
    const resolved = yield* checkedPath(root, requested);
    const beforeOpen = yield* io("Cannot inspect checkout file.", () => stat(resolved));
    if (!beforeOpen.isFile()) return yield* new SandboxError({ message: "Path is not a regular file." });
    return yield* Effect.scoped(Effect.gen(function* () {
      const file = yield* Effect.acquireRelease(
        io("Cannot open checkout file.", () => open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)),
        (handle) => Effect.promise(() => handle.close()),
      );
      const info = yield* io("Cannot inspect checkout file.", () => file.stat());
      if (!info.isFile()) return yield* new SandboxError({ message: "Path is not a regular file." });
      if (info.size > maximumFileBytes) return yield* new SandboxError({ message: `File exceeds the ${maximumFileBytes / 1024 / 1024} MiB read limit. Review it manually.` });
      const content = yield* io("Cannot read checkout file.", () => file.readFile("utf8"));
      if (content.includes("\0")) return yield* new SandboxError({ message: "Binary files cannot be read as text." });
      return content;
    }));
  });

  const readOptional = (requested: string): Effect.Effect<string | undefined, SandboxError> =>
    read(requested).pipe(Effect.catch((error) => isMissing(error) ? Effect.succeed(undefined) : Effect.fail(error)));

  const files: string[] = [];
  const walk = (directory: string): Effect.Effect<void, SandboxError> => Effect.gen(function* () {
    const entries = yield* io("Cannot list checkout files.", () => readdir(path.join(root, directory), { withFileTypes: true }));
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.toLowerCase() === ".git" || entry.isSymbolicLink()) continue;
      const relative = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) yield* walk(relative);
      else if (entry.isFile()) {
        files.push(relative);
        if (files.length > maximumFiles) return yield* new SandboxError({ message: `Checkout exceeds the ${maximumFiles.toLocaleString("en-US")}-file tool limit. Review cannot inspect it completely.` });
      }
    }
  });
  yield* walk("");
  return { files, read, readOptional };
});

export type CheckoutFilesystem = Effect.Success<ReturnType<typeof makeCheckoutFilesystem>>;
