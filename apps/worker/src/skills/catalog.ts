import { Effect } from "effect";
import type { CheckoutFilesystem } from "../sandbox/filesystem";

// Discovers instruction-only skills anywhere in the checkout, including nested repositories.
export const makeSkillCatalog = (filesystem: CheckoutFilesystem) => Effect.gen(function* () {
  const entries = yield* Effect.forEach(
    filesystem.files.filter((file) => file === "SKILL.md" || file.endsWith("/SKILL.md")),
    (file) => filesystem.read(file).pipe(Effect.map((body) => {
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(body)?.[1] ?? "";
      const field = (name: string) => new RegExp(`^${name}:\\s*(.+)$`, "m").exec(frontmatter)?.[1]?.trim().replace(/^(["'])(.*)\1$/, "$2");
      return { name: field("name") ?? file.split("/").at(-2) ?? "root", description: field("description") ?? "", path: file };
    })),
  );
  const hints: string[] = [];
  const hint = (message: string) => {
    if (!hints.includes(message)) hints.push(message);
    return message;
  };
  const load = (nameOrPath: string) => {
    const exact = entries.find((entry) => entry.path === nameOrPath);
    const matches = exact ? [exact] : entries.filter((entry) => entry.name === nameOrPath);
    if (matches.length === 0) return Effect.succeed(hint(`Skill "${nameOrPath}" is unavailable. Continue the review without it; add its SKILL.md to the repository to enable it. Use list_skills to see available skills.`));
    if (matches.length > 1) return Effect.succeed(hint(`Skill "${nameOrPath}" is ambiguous. Use its exact checkout-relative SKILL.md path from list_skills.`));
    const selected = matches[0]!;
    return filesystem.read(selected.path).pipe(Effect.map((body) => `${selected.path}\nReferences resolve relative to this skill's directory. Scripts and external tools cannot be executed.\n\n${body}`));
  };
  return { entries, hints, load };
});

export type SkillCatalog = Effect.Success<ReturnType<typeof makeSkillCatalog>>;
