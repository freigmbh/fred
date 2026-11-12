import { ConvexError } from "convex/values";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureReviewLabels, inspectProjectToken, reviewLabels } from "./gitlabTokens";
import { testTokenKey } from "./test.setup";
import { openToken, sealToken } from "./tokenVault";

const token = "glpat-inspected-token";
const self = { id: 5, name: "0 FRED", scopes: ["api"], active: true, revoked: false, expires_at: "2027-01-01" };
const user = { id: 901, username: "project_7_bot_fred", bot: true };
const project = { id: 7, path_with_namespace: "frei/flight-management" };
const label = z.object({ name: z.string() });

type Route = "self" | "user" | "projects" | "member" | "labels";

// A fake GitLab REST API for one project access token. Each route answers like a healthy "0 FRED" token unless overridden.
function gitlab(overrides: Partial<Record<Route, () => Response>> = {}) {
  const calls: { method: string; url: URL; token: string | null; body?: string }[] = [];
  const answers: Record<Route, () => Response> = {
    self: () => Response.json(self),
    user: () => Response.json(user),
    projects: () => Response.json([project]),
    member: () => Response.json({ access_level: 30 }),
    labels: () => Response.json([]),
    ...overrides,
  };
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({ method, url, token: new Headers(init?.headers).get("PRIVATE-TOKEN"), ...(init?.body ? { body: String(init.body) } : {}) });
    const path = url.pathname.replace(/^\/api\/v4\//, "");
    if (method === "POST" && path === "projects/7/labels") return Response.json(label.parse(JSON.parse(String(init?.body))), { status: 201 });
    const route = ({ "personal_access_tokens/self": "self", user: "user", projects: "projects",
      "projects/7/members/all/901": "member", "projects/7/labels": "labels" } as const satisfies Record<string, Route>)[path];
    if (!route) throw new Error(`unexpected GitLab request ${method} ${url}`);
    return answers[route]();
  };
  return { fetcher, calls };
}

// Awaits a check that must fail with a ConvexError and returns that error for assertions on its data.
async function refusal(check: Promise<unknown>) {
  const error = await check.then(() => undefined, (cause: unknown) => cause);
  expect(error).toBeInstanceOf(ConvexError);
  return error;
}

beforeEach(() => {
  vi.stubEnv("GITLAB_URL", "https://gitlab.invalid");
  vi.stubEnv("FRED_TOKEN_KEY", testTokenKey);
});
afterEach(() => vi.unstubAllEnvs());

describe("tokenVault", () => {
  it("opens a sealed token for its own project and never stores the plaintext", async () => {
    const sealed = await sealToken(token, "7");
    expect(sealed).not.toContain(token);
    expect(await openToken(sealed, "7")).toBe(token);
  });

  it("refuses to open a token sealed for another project", async () => {
    await expect(openToken(await sealToken(token, "7"), "8")).rejects.toThrow();
  });

  it.each([undefined, "", btoa("too short")])("rejects FRED_TOKEN_KEY %s with token_key_invalid", async (key) => {
    vi.stubEnv("FRED_TOKEN_KEY", key);
    expect(await refusal(sealToken(token, "7"))).toHaveProperty("data.code", "token_key_invalid");
  });
});

describe("inspectProjectToken", () => {
  it("identifies the token, its bot user, its single project, and the bot's role there", async () => {
    const api = gitlab();
    expect(await inspectProjectToken(token, api.fetcher)).toEqual({
      tokenId: 5, name: "0 FRED", scopes: ["api"], expiresAt: "2027-01-01", botUserId: "901", botUsername: "project_7_bot_fred",
      accessLevel: 30, gitlabProjectId: "7", path: "frei/flight-management",
    });
    expect(api.calls.every((call) => call.token === token && call.url.origin === "https://gitlab.invalid")).toBe(true);
  });

  it.each([
    { refusal: "a rejected token", overrides: { self: () => new Response(null, { status: 401 }) },
      message: "GitLab rejected the token. It is revoked, expired, or mistyped." },
    { refusal: "an inactive token", overrides: { self: () => Response.json({ ...self, active: false }) }, message: "The token is revoked or expired." },
    { refusal: "a revoked token", overrides: { self: () => Response.json({ ...self, revoked: true }) }, message: "The token is revoked or expired." },
    { refusal: "a token without api scope", overrides: { self: () => Response.json({ ...self, scopes: ["read_api"] }) }, message: "Give the token the api scope." },
    { refusal: "a person's token", overrides: { user: () => Response.json({ ...user, bot: false }) },
      message: "This token belongs to a person. Create a project access token in the project's Settings > Access tokens." },
    { refusal: "a token without a project", overrides: { projects: () => Response.json([]) },
      message: "Use a project access token. This token reaches more than one project, or none." },
    { refusal: "a token reaching two projects", overrides: { projects: () => Response.json([project, { id: 8, path_with_namespace: "frei/other" }]) },
      message: "Use a project access token. This token reaches more than one project, or none." },
    { refusal: "a Reporter token", overrides: { member: () => Response.json({ access_level: 20 }) }, message: "Give the token the Developer role or higher." },
  ])("refuses $refusal with the sentence the admin sees", async ({ overrides, message }) => {
    expect(await refusal(inspectProjectToken(token, gitlab(overrides).fetcher))).toHaveProperty("data", { code: "project_token", message });
  });
});

describe("ensureReviewLabels", () => {
  it("creates only the review labels the project cannot see, counting group labels", async () => {
    const api = gitlab({ labels: () => Response.json([{ name: "fred-review::clean" }, { name: "fred-review::other" }]) });
    expect(await ensureReviewLabels(token, "7", api.fetcher)).toEqual(["fred-review::findings"]);
    expect(api.calls[0]?.url.searchParams.get("include_ancestor_groups")).toBe("true");
    const created = api.calls.filter((call) => call.method === "POST");
    expect(created.map((call) => JSON.parse(call.body ?? "null"))).toEqual([reviewLabels[1]]);
  });
});
