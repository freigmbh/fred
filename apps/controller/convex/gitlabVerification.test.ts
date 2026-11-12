import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { authorizeFindingCommand } from "./gitlabVerification";

const note = { gitlabProjectId: "7", mrIid: 16, noteId: "123", actorId: "42", body: "fred dismiss finding-1 This behavior is intentional." };
const currentNote = { id: 123, body: note.body, system: false, author: { id: 42 } };
const currentMr = { iid: 16, project_id: 7, author: { id: 42 } };
// The project's FRED token, and the bots to ignore: this project's FRED bot 901, another project's 801, and other bots 903 and 904.
const access = { token: "project-test-token", botIds: ["901", "801", "903", "904"] };

function gitlab(replies: Partial<Record<"note" | "mr" | "member", () => Response>> = {}) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    const path = new URL(url).pathname;
    if (path.endsWith("/notes/123")) return replies.note?.() ?? Response.json(currentNote);
    if (path.endsWith("/merge_requests/16")) return replies.mr?.() ?? Response.json(currentMr);
    if (path.endsWith("/members/all/42")) return replies.member?.() ?? Response.json({ id: 42, access_level: 40 });
    throw new Error("unexpected GitLab request");
  };
  return { fetcher, calls };
}

beforeEach(() => {
  vi.stubEnv("GITLAB_URL", "https://gitlab.invalid");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

it("authorizes the verified MR author without a project membership request", async () => {
  const api = gitlab();
  expect(await authorizeFindingCommand(note, access, api.fetcher)).toEqual({ kind: "authorized" });
  expect(api.calls.map(({ url }) => url)).toEqual([
    "https://gitlab.invalid/api/v4/projects/7/merge_requests/16/notes/123",
    "https://gitlab.invalid/api/v4/projects/7/merge_requests/16",
  ]);
  for (const { init } of api.calls) {
    expect(init).toMatchObject({ method: "GET", redirect: "error", headers: { "PRIVATE-TOKEN": access.token } });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  }
});

it.each([40, 50])("authorizes effective membership access %i, including inherited access", async (access_level) => {
  const api = gitlab({
    mr: () => Response.json({ ...currentMr, author: { id: 99 } }),
    member: () => Response.json({ id: 42, access_level }),
  });
  expect(await authorizeFindingCommand(note, access, api.fetcher)).toEqual({ kind: "authorized" });
  expect(api.calls.at(-1)?.url).toBe("https://gitlab.invalid/api/v4/projects/7/members/all/42");
});

it.each([10, 20, 30, 404])("rejects a non-author with membership result %i", async (access_level) => {
  const api = gitlab({
    mr: () => Response.json({ ...currentMr, author: { id: 99 } }),
    member: () => access_level === 404 ? new Response(null, { status: 404 }) : Response.json({ id: 42, access_level }),
  });
  expect(await authorizeFindingCommand(note, access, api.fetcher)).toEqual({
    kind: "denied",
  });
});

it.each([
  { id: 124 },
  { body: "fred dismiss finding-1 The author edited this note." },
  { author: { id: 43 } },
  { author: { id: 42, bot: true } },
  { system: true },
])("ignores a current note that differs from the delivered command or is automated: %j", async (override) => {
  const api = gitlab({ note: () => Response.json({ ...currentNote, ...override }) });
  expect(await authorizeFindingCommand(note, access, api.fetcher)).toEqual({ kind: "ignored" });
  expect(api.calls).toHaveLength(1);
});

it.each([901, 801, 903, 904])("ignores bot %i even if it could be the MR author", async (id) => {
  const api = gitlab();
  expect(await authorizeFindingCommand({ ...note, actorId: String(id) }, access, api.fetcher)).toEqual({ kind: "ignored" });
  expect(api.calls).toHaveLength(0);
});

it("sends only the project token, only to the configured GitLab", async () => {
  const api = gitlab();
  expect(await authorizeFindingCommand(note, access, api.fetcher)).toEqual({ kind: "authorized" });
  expect(api.calls[0]?.init?.headers).toEqual({ "PRIVATE-TOKEN": "project-test-token" });
  expect(api.calls.every(({ url }) => new URL(url).origin === "https://gitlab.invalid")).toBe(true);
});

it("fails verification as configuration without requests when the project has no usable token", async () => {
  const api = gitlab();
  expect(await authorizeFindingCommand(note, { ...access, token: null }, api.fetcher)).toEqual({ kind: "failed", reason: "configuration" });
  expect(api.calls).toHaveLength(0);
});

it.each(["note", "mr", "member"] as const)("requests retry after a transient %s API error", async (route) => {
  const api = gitlab({
    mr: () => Response.json({ ...currentMr, author: { id: 99 } }),
    [route]: () => new Response(null, { status: 503 }),
  });
  expect(await authorizeFindingCommand(note, access, api.fetcher)).toEqual({ kind: "retry" });
});

it.each([302, 401, 403])("fails verification when GitLab refuses the bot request with HTTP %i", async (status) => {
  const api = gitlab({ note: () => new Response(null, { status }) });
  expect(await authorizeFindingCommand(note, access, api.fetcher)).toEqual({ kind: "failed", reason: "gitlab" });
});

it.each([408, 429])("retries transient HTTP %i responses", async (status) => {
  const api = gitlab({ note: () => new Response(null, { status }) });
  expect(await authorizeFindingCommand(note, access, api.fetcher)).toEqual({ kind: "retry" });
});

it.each(["note", "mr"] as const)("ignores a deleted %s", async (route) => {
  const api = gitlab({ [route]: () => new Response(null, { status: 404 }) });
  expect(await authorizeFindingCommand(note, access, api.fetcher)).toEqual({ kind: "ignored" });
});

it("requests retry after malformed API data or a failed request without exposing its error", async () => {
  const api = gitlab({ note: () => Response.json({ id: 123 }) });
  expect(await authorizeFindingCommand(note, access, api.fetcher)).toEqual({ kind: "retry" });
  const failingFetch: typeof fetch = async () => { throw new Error("a transport error containing private data"); };
  expect(await authorizeFindingCommand(note, access, failingFetch)).toEqual({ kind: "retry" });
});

it.each(["", "file:///tmp/gitlab", "https://user:password@gitlab.invalid", "https://gitlab.invalid?other=host"])("does not request an invalid configured GitLab URL: %s", async (base) => {
  vi.stubEnv("GITLAB_URL", base);
  const api = gitlab();
  expect(await authorizeFindingCommand(note, access, api.fetcher)).toEqual({ kind: "failed", reason: "configuration" });
  expect(api.calls).toHaveLength(0);
});
