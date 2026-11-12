import type { Projects, StageModels } from "./api";
import { dayMs } from "./time";

export type ProjectRow = Projects["projects"][number];
export type CatalogModel = Projects["catalog"][number];
export type Pipeline = StageModels;

// The name every project's FRED bot should have. GitLab names a project bot after its token and cannot rename it later.
export const botName = "0 FRED";

export const stages = [
  { id: "detect", label: "Detect", description: "Detects candidate findings in the diff" },
  { id: "validate", label: "Validate", description: "Validates each candidate" },
] as const satisfies readonly { id: keyof Pipeline; label: string; description: string }[];

// GitLab's names for the access levels a project bot can hold.
const roles: Record<number, string> = { 30: "Developer", 40: "Maintainer", 50: "Owner" };

export function roleName(accessLevel: number) {
  return roles[accessLevel] ?? `access ${accessLevel}`;
}

const daysLeft = (expiresAt: string, now: number) => Math.ceil((Date.parse(`${expiresAt}T00:00:00Z`) - now) / dayMs);

// "expires in 12d", "expired", or "no expiry" for a token's yyyy-mm-dd expiry.
export function expiryText(expiresAt: string | null, now: number) {
  if (expiresAt === null) return "no expiry";
  const days = daysLeft(expiresAt, now);
  return days <= 0 ? "expired" : `expires in ${days}d`;
}

// A token's tone and state word, its short text for the project list, and the sentence telling the admin what to fix: off when
// unconnected, bad for a GitLab problem or a past expiry, warn for expiry within 30 days or a bot not named 0 FRED, else ok.
export function tokenHealth(token: ProjectRow["token"], now: number) {
  if (!token) return { tone: "off", state: "Not connected", text: "not connected", fix: null } as const;
  if (token.problem) return { tone: "bad", state: "Failing", text: token.problem, fix: `${token.problem} Reviews fail until you replace it.` } as const;
  const days = token.expiresAt === null ? Infinity : daysLeft(token.expiresAt, now);
  const text = expiryText(token.expiresAt, now);
  if (days <= 0) return { tone: "bad", state: "Failing", text, fix: "Token expired. Reviews fail until you replace it." } as const;
  if (days <= 30) return { tone: "warn", state: "Needs attention", text, fix: `Token ${text}. Rotate it in GitLab and replace it here.` } as const;
  if (token.name !== botName) {
    return { tone: "warn", state: "Needs attention", text: `named ${token.name}`,
      fix: `The bot is named ${token.name}, so developers will not find ${botName} as reviewer. Create a token named ${botName} and replace it here.` } as const;
  }
  return { tone: "ok", state: "Works", text, fix: null } as const;
}

// The project list's groups in order, connected first. Empty groups are left out.
export function projectGroups(projects: readonly ProjectRow[]) {
  return [
    { title: "Connected", projects: projects.filter((project) => project.token) },
    { title: "Not connected", projects: projects.filter((project) => !project.token) },
  ].filter((group) => group.projects.length > 0);
}

export function supportsEffort(model: CatalogModel | undefined, effort: string) {
  return model?.efforts.some((option) => option === effort) ?? false;
}

// Mirrors the controller's check so Save and Connect stay disabled until every stage names a catalog model with a supported
// effort. The controller still validates each save.
export function pipelineValid(pipeline: Pipeline, catalog: readonly CatalogModel[]) {
  return stages.every(({ id }) => supportsEffort(catalog.find((model) => model.id === pipeline[id].model), pipeline[id].effort));
}

export function samePipeline(a: Pipeline, b: Pipeline) {
  return stages.every(({ id }) => a[id].model === b[id].model && a[id].effort === b[id].effort);
}
