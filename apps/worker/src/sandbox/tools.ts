import type { DiagnosticEvent } from "@fred/contracts";
import { Effect } from "effect";
import { z } from "zod";
import { SandboxError } from "../errors";
import { Diagnostics } from "../diagnostics/recorder";
import { listDiffsInput, readDiffInput, type DiffCatalog } from "../diffCatalog";
import { maximumFileBytes } from "./filesystem";
import type { Workspace } from "./workspace";

const readInput = z.object({ path: z.string().min(1), startLine: z.number().int().positive().default(1), maxLines: z.number().int().min(1).max(500).default(200) });
const globInput = z.object({ pattern: z.string().min(1).max(500), limit: z.number().int().min(1).max(1000).default(200) });
const grepInput = z.object({ query: z.string().min(1).max(1000), pattern: z.string().min(1).max(500).default("**/*"), limit: z.number().int().min(1).max(500).default(100) });
const loadInput = z.object({ name: z.string().min(1).max(500) });

// Matches the documented glob subset in bounded time, including hidden files.
const matchesGlob = (file: string, pattern: string) => {
  const tokens = pattern.match(/\*\*\/|\*\*|[\s\S]/g) ?? [];
  let previous = Array.from({ length: file.length + 1 }, (_, index) => index === 0);
  for (const token of tokens) {
    const next = Array<boolean>(file.length + 1).fill(false);
    let prefixMatched = false;
    for (let index = 0; index <= file.length; index++) {
      if (token === "**/") {
        next[index] = previous[index]! || (prefixMatched && file[index - 1] === "/");
        prefixMatched ||= previous[index]!;
      } else if (token === "*" || token === "**") {
        next[index] = previous[index]! || (index > 0 && next[index - 1]! && (token === "**" || file[index - 1] !== "/"));
      } else if (index > 0) {
        next[index] = previous[index - 1]! && (token === "?" ? file[index - 1] !== "/" : file[index - 1] === token);
      }
    }
    previous = next;
  }
  return previous[file.length]!;
};

// A model-facing tool: its arguments are validated against `inputSchema` before `run` sees them.
const tool = <A>(description: string, inputSchema: z.ZodType<A>, run: (args: A) => Effect.Effect<string, SandboxError>) => ({
  description, inputSchema,
  execute: (input: unknown) => {
    const parsed = inputSchema.safeParse(input);
    return parsed.success ? run(parsed.data) : Effect.fail(new SandboxError({ message: `Invalid tool arguments: ${parsed.error.message}` }));
  },
});

type ToolName = Exclude<NonNullable<DiagnosticEvent["tool"]>, "denied">;

// Builds the model-facing tools for one stage: controlled checkout reads plus paged access to the job's diff catalog.
// Their names are the diagnostic tool names, so every call is recorded under its own name and anything else as denied.
export const makeCheckoutTools = ({ filesystem, skills }: Workspace, diffCatalog: DiffCatalog) => Effect.gen(function* () {
  const diagnostics = yield* Diagnostics;
  const tools = {
    read: tool(`Read numbered lines from a checkout-relative text file. Maximum file size ${maximumFileBytes / 1024 / 1024} MiB; .git and paths outside the checkout are denied.`, readInput, (args) => Effect.gen(function* () {
      const content = yield* filesystem.read(args.path);
      const lines = content.split("\n");
      const selected = lines.slice(args.startLine - 1, args.startLine - 1 + args.maxLines);
      const body = selected.map((line, index) => `${args.startLine + index}: ${line}`).join("\n");
      return `${args.path} (${lines.length} lines)\n${body.slice(0, 100_000)}${body.length > 100_000 ? "\nOutput truncated at 100,000 characters." : ""}`;
    })),
    glob: tool("List checkout files matching a glob. Supports *, **, and ?. Symlinks and .git are excluded. Output explicitly reports truncation.", globInput, (args) => Effect.sync(() => {
      const matching = filesystem.files.filter((file) => matchesGlob(file, args.pattern));
      return JSON.stringify({ files: matching.slice(0, args.limit), total: matching.length, truncated: matching.length > args.limit });
    })),
    grep: tool("Search a literal, case-sensitive string in checkout text files. Supports the same path glob as glob. Reports skipped files and truncated results.", grepInput, (args) => Effect.gen(function* () {
      const matches: { path: string; line: number; text: string }[] = [];
      const skipped: string[] = [];
      let truncated = false;
      for (const file of filesystem.files.filter((file) => matchesGlob(file, args.pattern))) {
        if (truncated) break;
        const content = yield* filesystem.read(file).pipe(Effect.catch(() => { skipped.push(file); return Effect.succeed(null); }));
        if (content === null) continue;
        for (const [index, line] of content.split("\n").entries()) {
          if (!line.includes(args.query)) continue;
          if (matches.length === args.limit) { truncated = true; break; }
          matches.push({ path: file, line: index + 1, text: line.slice(0, 2000) });
        }
      }
      return JSON.stringify({ matches, skippedFiles: skipped, truncated });
    })),
    list_skills: tool("List repository SKILL.md names, descriptions, and exact paths, including nested skills.", z.object({}), () => Effect.succeed(JSON.stringify({ skills: skills.entries }))),
    load_skill: tool("Read a repository skill by name or exact SKILL.md path. Missing skills return a hint; continue the review. Skills grant no script execution or external tool access.", loadInput, (args) => skills.load(args.name)),
    read_diff: { description: "Read a bounded page of an immutable review diff by CHANGED FILES id and scope or full range. Includes deleted text, original file line numbers, and nextCursor. Follow the cursor for remaining text, including long lines. No filesystem access.", inputSchema: readDiffInput, execute: diffCatalog.read },
    list_diffs: { description: "Read a bounded page of the complete changed-file catalog when it is not inlined. Concatenate text across pages to reconstruct JSON lines; a long row may span pages. Follow nextCursor until null before selecting patches. No filesystem access.", inputSchema: listDiffsInput, execute: diffCatalog.list },
  } satisfies Record<ToolName, { description: string; inputSchema: z.ZodType; execute: (input: unknown) => Effect.Effect<string, SandboxError> }>;
  const isTool = (name: string): name is ToolName => Object.hasOwn(tools, name);
  const definitions = Object.entries(tools).map(([name, { description, inputSchema }]) => ({ name, description, inputSchema }));
  const execute = (name: string, input: unknown) => Effect.suspend(() => {
    const known = isTool(name) ? name : undefined;
    const started = Date.now();
    diagnostics.emit({ kind: "tool_started", tool: known ?? "denied" });
    const run = known ? tools[known].execute(input)
      : Effect.fail(new SandboxError({ message: `Tool "${name}" is not permitted. Available tools: ${Object.keys(tools).join(", ")}.` }));
    return run.pipe(Effect.onExit((exit) => Effect.sync(() => {
      diagnostics.emit({ kind: "tool_completed", tool: known ?? "denied", durationMs: Date.now() - started, outcome: exit._tag === "Success" ? "success" : "failure" });
    })));
  });
  return { definitions, execute };
});

export type CheckoutTools = Effect.Success<ReturnType<typeof makeCheckoutTools>>;
