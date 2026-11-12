import { reviewLabels as labelNames } from "@fred/contracts";
import { ConvexError } from "convex/values";
import { z } from "zod";
import { botAvatarPng } from "./botAvatar";
import { gitlabRest } from "./gitlabRest";

// The scoped labels FRED sets on reviewed MRs.
export const reviewLabels = [
  { name: labelNames.clean, color: "#2e7d32", description: "FRED has no open blocking or should-fix finding on this MR." },
  { name: labelNames.findings, color: "#8e1b3a", description: "FRED has at least one open blocking or should-fix finding on this MR." },
];

const developerAccess = 30;
const tokenSelf = z.object({ id: z.number(), name: z.string(), scopes: z.array(z.string()), active: z.boolean(), revoked: z.boolean(), expires_at: z.string().nullable() });
const botUser = z.object({ id: z.number(), username: z.string(), bot: z.boolean().optional() });
const memberProject = z.object({ id: z.number(), path_with_namespace: z.string() });
const membership = z.object({ access_level: z.number() });
const label = z.object({ name: z.string() });

// Throws a `project_token` ConvexError whose message the admin sees next to the project.
function problem(message: string): never {
  throw new ConvexError({ code: "project_token", message });
}

// Reads and writes GitLab as one token for the admin. Every failure becomes a `problem`; nothing is retried.
function adminRequests(token: string, fetcher: typeof fetch) {
  const rest = gitlabRest(token, fetcher);
  if (!rest) problem("Set GITLAB_URL on the controller.");
  return async <A>(path: string, schema: z.ZodType<A>, json?: unknown) => {
    const route = path.split("?")[0];
    let response: Response;
    try {
      response = await rest(path, json === undefined ? {} : { method: "POST", json });
    } catch {
      problem("GitLab is unreachable from the controller. Try again.");
    }
    if (response.status === 401) problem("GitLab rejected the token. It is revoked, expired, or mistyped.");
    if (response.status === 403) problem(`GitLab refused ${route}. Give the token the api scope and the Developer role.`);
    if (!response.ok) problem(`GitLab answered HTTP ${response.status} for ${route}.`);
    const parsed = schema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) problem(`GitLab returned an unexpected response for ${route}.`);
    return parsed.data;
  };
}

// Identifies a project access token: its metadata, its bot user, the single project it belongs to, and the bot's role there.
// Throws a `project_token` ConvexError with an admin-facing message when the token cannot review.
export async function inspectProjectToken(token: string, fetcher: typeof fetch = fetch) {
  const get = adminRequests(token, fetcher);
  const self = await get("personal_access_tokens/self", tokenSelf);
  if (!self.active || self.revoked) problem("The token is revoked or expired.");
  if (!self.scopes.includes("api")) problem("Give the token the api scope.");
  const user = await get("user", botUser);
  if (!user.bot) problem("This token belongs to a person. Create a project access token in the project's Settings > Access tokens.");
  const projects = await get("projects?membership=true&simple=true&per_page=2", z.array(memberProject));
  const project = projects.length === 1 ? projects[0] : undefined;
  if (!project) problem("Use a project access token. This token reaches more than one project, or none.");
  const member = await get(`projects/${project.id}/members/all/${user.id}`, membership);
  if (member.access_level < developerAccess) problem("Give the token the Developer role or higher.");
  return {
    tokenId: self.id, name: self.name, scopes: self.scopes, expiresAt: self.expires_at,
    botUserId: String(user.id), botUsername: user.username, accessLevel: member.access_level,
    gitlabProjectId: String(project.id), path: project.path_with_namespace,
  };
}

// Creates the review labels the project cannot see yet, as project labels. Returns the names it created.
export async function ensureReviewLabels(token: string, gitlabProjectId: string, fetcher: typeof fetch = fetch) {
  const request = adminRequests(token, fetcher);
  const project = `projects/${encodeURIComponent(gitlabProjectId)}`;
  const visible = await request(`${project}/labels?include_ancestor_groups=true&search=fred-review&per_page=100`, z.array(label));
  const missing = reviewLabels.filter((wanted) => !visible.some((existing) => existing.name === wanted.name));
  for (const wanted of missing) await request(`${project}/labels`, label, wanted);
  return missing.map((created) => created.name);
}

// Uploads FRED's face as the avatar of the token's bot user. Returns false instead of throwing when GitLab refuses or is
// unreachable, because a default avatar must not block a connect.
export async function setBotAvatar(token: string, fetcher: typeof fetch = fetch) {
  const rest = gitlabRest(token, fetcher);
  if (!rest) return false;
  const form = new FormData();
  form.append("avatar", new Blob([botAvatarPng()], { type: "image/png" }), "fred.png");
  try {
    return (await rest("user/avatar", { method: "PUT", form })).ok;
  } catch {
    return false;
  }
}

// Checks one stored token against GitLab and never throws. Returns `{ inspection }`, or `{ problem }` when the token cannot be
// opened, fails inspection, or now reaches another project or bot.
export async function checkToken(token: string | null, gitlabProjectId: string | null, botUserId: string, fetcher: typeof fetch = fetch) {
  if (token === null || gitlabProjectId === null) return { problem: "FRED cannot open this token. Check FRED_TOKEN_KEY, or connect the project again." };
  try {
    const found = await inspectProjectToken(token, fetcher);
    if (found.gitlabProjectId !== gitlabProjectId || found.botUserId !== botUserId) return { problem: "The token now belongs to another project or bot. Connect the project again." };
    const { tokenId, name, scopes, expiresAt, accessLevel } = found;
    return { inspection: { tokenId, name, scopes, expiresAt, accessLevel } };
  } catch (error) {
    if (error instanceof ConvexError && typeof error.data === "object" && error.data !== null && "message" in error.data) return { problem: String(error.data.message) };
    return { problem: "The token check failed unexpectedly. Try again." };
  }
}
