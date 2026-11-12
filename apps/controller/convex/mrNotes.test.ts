import { z } from "zod";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import { scheduleMrNote } from "./mrNotes";
import schema from "./schema";
import { connectProject, fixtureBot, modules, testTokenKey } from "./test.setup";

const note = {
  key: "job-1",
  gitlabProjectId: "7",
  projectPath: "team/repo",
  mrIid: 1,
  provider: "fred" as const,
  body: "AI review failed: error",
};

// A test deployment whose note project is connected with the fixture bot's token.
async function setup() {
  const t = convexTest(schema, modules);
  await connectProject(t, { gitlabProjectId: note.gitlabProjectId, path: note.projectPath });
  return t;
}

function gitlabAccepts(_url: string | URL | Request, init?: RequestInit) {
  return Promise.resolve(init?.method === "GET" ? Response.json([]) : Response.json({ id: 1 }));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("GITLAB_URL", "https://gitlab.invalid");
  vi.stubEnv("FRED_TOKEN_KEY", testTokenKey);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

// A GitLab notes API that lists what was posted and refuses the first POSTs with `refusals`. Records every request.
function notesApi(refusals: number[]) {
  const posted: string[] = [];
  const requests: RequestInit[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    requests.push(init ?? {});
    if (init?.method !== "POST") return Response.json(posted.map((body) => ({ body })));
    const status = refusals.shift();
    if (status !== undefined) return new Response("refused", { status });
    posted.push(z.object({ body: z.string() }).parse(JSON.parse(String(init.body))).body);
    return Response.json({ id: posted.length });
  });
  return { posted, requests };
}

it.each(["fred", "claude"] as const)("a %s note retries a 503 and posts one comment with the project token, never following a redirect", async (provider) => {
  const t = await setup();
  const gitlab = notesApi([503]);
  await t.run((ctx) => scheduleMrNote(ctx, { ...note, provider }));
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(gitlab.posted).toEqual([expect.stringContaining(note.body)]);
  expect(await t.run((ctx) => ctx.db.query("mrNotes").collect())).toMatchObject([{ status: "sent", attempts: 2 }]);
  expect(gitlab.requests).toEqual(gitlab.requests.map(() => expect.objectContaining({
    redirect: "error", headers: expect.objectContaining({ "PRIVATE-TOKEN": fixtureBot.token }),
  })));
});

it("finds a successful POST on a later notes page after its response was lost", async () => {
  const t = await setup();
  let body = "";
  const fetch = vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json([]))
    .mockImplementationOnce(async (_url, init) => {
      body = z.object({ body: z.string() }).parse(JSON.parse(String(init?.body))).body;
      throw new TypeError("connection lost");
    })
    .mockResolvedValueOnce(Response.json([{ body: "unrelated" }], { headers: { "x-next-page": "2" } }))
    .mockImplementationOnce(async () => Response.json([{ body }]));
  await t.run((ctx) => scheduleMrNote(ctx, note));
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(fetch.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "POST", "GET", "GET"]);
  expect(fetch.mock.calls[3]?.[0]).toContain("page=2");
  expect(await t.run((ctx) => ctx.db.query("mrNotes").collect())).toMatchObject([{ status: "sent", attempts: 2 }]);
});

it.each([401, 403, 404, 429, 503])("bounds retries for HTTP %i and retains the delivery error", async (status) => {
  const t = await setup();
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_url, init) => (init?.method === "GET" ? Response.json([]) : new Response("failure", { status })));
  await t.run((ctx) => scheduleMrNote(ctx, note));
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const attempts = status >= 500 || status === 429 ? 5 : 1;
  expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(attempts);
  expect(await t.run((ctx) => ctx.db.query("mrNotes").collect())).toMatchObject([
    { status: "failed", attempts, lastError: `GitLab note request failed: ${status}` },
  ]);
});

it("duplicate scheduling and repeated delivery of a sent note do not post again", async () => {
  const t = await setup();
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(gitlabAccepts);
  await t.run(async (ctx) => {
    await scheduleMrNote(ctx, note);
    await scheduleMrNote(ctx, note);
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const rows = await t.run((ctx) => ctx.db.query("mrNotes").collect());
  expect(rows).toHaveLength(1);
  await t.action(internal.gitlabApi.postMrNote, { noteId: rows[0]!._id });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("fails once without a GitLab request when the note's project is not connected", async () => {
  const t = convexTest(schema, modules);
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(gitlabAccepts);
  await t.run((ctx) => scheduleMrNote(ctx, note));
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(fetch).not.toHaveBeenCalled();
  expect(await t.run((ctx) => ctx.db.query("mrNotes").collect())).toMatchObject([
    { status: "failed", attempts: 1, lastError: "GitLab configuration invalid or project not connected" },
  ]);
});

it("an operator can retry a failed delivery without duplicating an existing comment", async () => {
  const t = await setup();
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("forbidden", { status: 403 }));
  await t.run((ctx) => scheduleMrNote(ctx, note));
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const failed = await t.run((ctx) => ctx.db.query("mrNotes").first());
  expect(failed?.status).toBe("failed");
  fetch.mockImplementation(async () => Response.json([{ body: `existing comment <!-- fred-note:${failed!._id} -->` }]));
  await t.mutation(internal.mrNotes.retryFailed, { noteId: failed!._id });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(await t.run((ctx) => ctx.db.get(failed!._id))).toMatchObject({ status: "sent", attempts: 1 });
  expect(fetch.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
});
