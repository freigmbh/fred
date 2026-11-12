import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import { verifyRequest } from "./findingCommandRequests";
import schema from "./schema";
import { connectProject, modules, testTokenKey } from "./test.setup";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("GITLAB_WEBHOOK_SECRET", "hook-test");
  vi.stubEnv("GITLAB_URL", "https://gitlab.invalid");
  vi.stubEnv("FRED_TOKEN_KEY", testTokenKey);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function fixture() {
  const t = convexTest(schema, modules);
  const projectId = await connectProject(t, { gitlabProjectId: "7", path: "team/repo" });
  const findingId = await t.run(async (ctx) => {
    const developerId = await ctx.db.insert("developers", { gitlabUserId: "42" });
    const jobId = await ctx.db.insert("reviewJobs", {
      projectId, developerId, mrIid: 16, provider: "fred", status: "done", headSha: "head", triggeredBy: "42",
    });
    return ctx.db.insert("findings", {
      projectId, jobId, mrIid: 16, provider: "fred", status: "posted", disposition: "open", resultIndex: 0,
      file: "main.ts", title: "Finding", body: "Finding details", severity: "should_fix",
    });
  });
  const note = `fred dismiss ${findingId} This behavior is intentional.`;
  const payload = {
    object_kind: "note",
    project: { id: 7, path_with_namespace: "team/repo", web_url: "https://untrusted.invalid" },
    user: { id: 42, email: "must-not-be-stored@example.invalid" },
    object_attributes: { id: 123, note, noteable_type: "MergeRequest", action: "create", system: false, author_id: 42 },
    merge_request: { iid: 16 },
  };
  const deliver = () => t.fetch("/webhook/gitlab", { method: "POST",
    headers: { "X-Gitlab-Token": "hook-test", "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const receipt = async () => {
    const row = await t.run((ctx) => ctx.db.query("findingCommandRequests").unique());
    if (!row) throw new Error("expected command receipt");
    return row;
  };
  const finishScheduled = async () => {
    while (vi.getTimerCount() > 0) {
      await vi.advanceTimersToNextTimerAsync();
      await t.finishInProgressScheduledFunctions();
    }
  };
  return { t, findingId, payload, note, deliver, receipt, finishScheduled };
}

function gitlab(note: string, overrides: Partial<Record<"note" | "mr" | "member", () => Response>> = {}) {
  const calls: { url: string; method: string | undefined; at: number }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const path = new URL(url).pathname;
    calls.push({ url, method: init?.method, at: Date.now() });
    if (init?.method === "GET" && path.endsWith("/notes/123")) {
      return overrides.note?.() ?? Response.json({ id: 123, body: note, system: false, author: { id: 42 } });
    }
    if (init?.method === "GET" && path.endsWith("/merge_requests/16")) {
      return overrides.mr?.() ?? Response.json({ iid: 16, project_id: 7, author: { id: 42 } });
    }
    if (init?.method === "GET" && path.endsWith("/members/all/42")) {
      return overrides.member?.() ?? Response.json({ id: 42, access_level: 40 });
    }
    if (path.endsWith("/notes")) return Response.json(init?.method === "GET" ? [] : { id: 124 });
    throw new Error("unexpected test GitLab request");
  };
  vi.stubGlobal("fetch", fetcher);
  return { calls, fetcher };
}

it("returns HTTP 200 after durable admission without a GitLab request", async () => {
  const f = await fixture();
  const api = gitlab(f.note);
  const response = await f.deliver();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ received: true });
  expect(api.calls).toHaveLength(0);
  const receipt = await f.receipt();
  expect(receipt).toMatchObject({ noteId: "123", status: "pending", attempts: 0,
    command: { mrIid: 16, actorId: "42", action: "dismiss", reference: f.findingId, reason: "This behavior is intentional.", body: f.note },
  });
  expect(Object.keys(receipt.command).sort()).toEqual(["action", "actorId", "body", "mrIid", "reason", "reference"]);
  expect(JSON.stringify(receipt)).not.toContain("must-not-be-stored");
  expect(JSON.stringify(receipt)).not.toContain("untrusted.invalid");
  expect(await f.t.run((ctx) => ctx.db.query("findingCommands").collect())).toHaveLength(0);
});

it("admits concurrent duplicate deliveries once and verifies through the scheduler", async () => {
  const f = await fixture();
  const api = gitlab(f.note);
  const responses = await Promise.all([f.deliver(), f.deliver()]);
  expect(responses.every((response) => response.status === 200)).toBe(true);
  expect(api.calls).toHaveLength(0);
  expect(await f.t.run((ctx) => ctx.db.query("findingCommandRequests").collect())).toHaveLength(1);
  expect(await f.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).toHaveLength(1);
  await f.finishScheduled();
  expect(await f.receipt()).toMatchObject({ status: "done", attempts: 1 });
  expect(await f.t.run((ctx) => ctx.db.query("findingCommands").collect())).toMatchObject([{
    findingId: f.findingId, actorId: "42", action: "dismiss", status: "queued", provider: "fred", noteId: "123",
  }]);
  expect(await f.t.run((ctx) => ctx.db.query("webhookDeliveries").collect())).toHaveLength(1);
});

it("ignores unknown projects without scheduling verification", async () => {
  const f = await fixture();
  const api = gitlab(f.note);
  f.payload.project.id = 8;
  const response = await f.deliver();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ignored: true });
  expect(api.calls).toHaveLength(0);
  expect(await f.t.run((ctx) => ctx.db.query("findingCommandRequests").collect())).toHaveLength(0);
});

it("recovers a transient API failure without a second webhook delivery", async () => {
  const f = await fixture();
  let attempts = 0;
  const api = gitlab(f.note, { note: () => ++attempts === 1 ? new Response(null, { status: 503 })
    : Response.json({ id: 123, body: f.note, system: false, author: { id: 42 } }) });
  expect((await f.deliver()).status).toBe(200);
  await f.finishScheduled();
  expect(await f.receipt()).toMatchObject({ status: "done", attempts: 2 });
  expect(attempts).toBe(2);
  const reads = api.calls.filter((call) => call.url.endsWith("/notes/123"));
  expect(reads[1]!.at - reads[0]!.at).toBe(5_000);
  expect(await f.t.run((ctx) => ctx.db.query("findingCommands").collect())).toHaveLength(1);
  expect(await f.t.run((ctx) => ctx.db.query("findingDecisions").collect())).toHaveLength(0);
});

it("bounds transient retries and publishes one explanation after exhaustion", async () => {
  const f = await fixture();
  const api = gitlab(f.note, { note: () => new Response("private upstream error", { status: 503 }) });
  await f.deliver();
  await f.finishScheduled();
  expect(await f.receipt()).toMatchObject({ status: "failed", attempts: 4, failure: "exhausted" });
  const reads = api.calls.filter((call) => call.url.endsWith("/notes/123"));
  expect(reads).toHaveLength(4);
  expect(reads.slice(1).map((read, index) => read.at - reads[index]!.at)).toEqual([5_000, 30_000, 120_000]);
  const notes = await f.t.run((ctx) => ctx.db.query("mrNotes").collect());
  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatchObject({ status: "sent", body: "Finding command could not be verified: GitLab verification failed after four attempts. No finding was changed. Post a new command after the problem is corrected." });
  expect(JSON.stringify(notes)).not.toContain("private upstream error");
  expect(await f.t.run((ctx) => ctx.db.query("findingCommands").collect())).toHaveLength(0);
  await f.deliver();
  await f.finishScheduled();
  expect(api.calls.filter((call) => call.url.endsWith("/notes/123"))).toHaveLength(4);
});

it("records configuration failure immediately even when its explanation cannot be delivered", async () => {
  const f = await fixture();
  const api = gitlab(f.note);
  await f.t.run(async (ctx) => {
    for (const row of await ctx.db.query("projectTokens").collect()) await ctx.db.delete(row._id);
  });
  expect((await f.deliver()).status).toBe(200);
  await f.finishScheduled();
  expect(await f.receipt()).toMatchObject({ status: "failed", attempts: 1, failure: "configuration" });
  expect(api.calls).toHaveLength(0);
  const notes = await f.t.run((ctx) => ctx.db.query("mrNotes").collect());
  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatchObject({ status: "failed", body: "Finding command could not be verified: GitLab configuration is unavailable or invalid. No finding was changed. Post a new command after the problem is corrected." });
  expect(await f.t.run((ctx) => ctx.db.query("findingCommands").collect())).toHaveLength(0);
});

it("stops after a permanent GitLab refusal and sends an explanation", async () => {
  const f = await fixture();
  gitlab(f.note, { note: () => new Response(null, { status: 403 }) });
  await f.deliver();
  await f.finishScheduled();
  expect(await f.receipt()).toMatchObject({ status: "failed", attempts: 1, failure: "gitlab" });
  const notes = await f.t.run((ctx) => ctx.db.query("mrNotes").collect());
  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatchObject({ status: "sent" });
  expect(await f.t.run((ctx) => ctx.db.query("findingCommands").collect())).toHaveLength(0);
});

it("rechecks the current note on retry and ignores an edited command", async () => {
  const f = await fixture();
  let attempts = 0;
  gitlab(f.note, { note: () => ++attempts === 1 ? new Response(null, { status: 503 })
    : Response.json({ id: 123, body: "This command was edited.", system: false, author: { id: 42 } }) });
  await f.deliver();
  await f.finishScheduled();
  expect(await f.receipt()).toMatchObject({ status: "ignored", attempts: 2 });
  expect(await f.t.run((ctx) => ctx.db.query("findingCommands").collect())).toHaveLength(0);
  expect(await f.t.run((ctx) => ctx.db.query("mrNotes").collect())).toHaveLength(0);
});

it("creates one durable rejection note when the verified author lacks permission", async () => {
  const f = await fixture();
  gitlab(f.note, { mr: () => Response.json({ iid: 16, project_id: 7, author: { id: 99 } }),
    member: () => Response.json({ id: 42, access_level: 30 }) });
  await Promise.all([f.deliver(), f.deliver()]);
  await f.finishScheduled();
  expect(await f.receipt()).toMatchObject({ status: "done", attempts: 1 });
  expect(await f.t.run((ctx) => ctx.db.query("findingCommands").collect())).toHaveLength(0);
  const notes = await f.t.run((ctx) => ctx.db.query("mrNotes").collect());
  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatchObject({ provider: "fred", status: "sent",
    body: "Finding command rejected: Only the MR author or a project Maintainer can change findings.",
  });
});

it("enqueues once when the scheduled action is executed twice for one attempt", async () => {
  const f = await fixture();
  const api = gitlab(f.note);
  await f.deliver();
  const { _id: requestId } = await f.receipt();
  await f.t.mutation(internal.findingCommandRequests.dispatch, { requestId });
  await Promise.all([1, 2].map(() => f.t.action((ctx) => verifyRequest(ctx, requestId, 1, api.fetcher))));
  await f.finishScheduled();
  expect(await f.receipt()).toMatchObject({ status: "done", attempts: 1 });
  expect(await f.t.run((ctx) => ctx.db.query("findingCommands").collect())).toHaveLength(1);
  expect(await f.t.run((ctx) => ctx.db.query("webhookDeliveries").collect())).toHaveLength(1);
});

it("recovers an action crash through the pre-scheduled mutation and rejects its late completion", async () => {
  const f = await fixture();
  const api = gitlab(f.note);
  await f.deliver();
  const { _id: requestId } = await f.receipt();
  const startedAt = Date.now();
  await f.t.mutation(internal.findingCommandRequests.dispatch, { requestId });
  expect(await f.receipt()).toMatchObject({ status: "verifying", attempts: 1, nextAttemptAt: startedAt + 45_000 });
  const scheduled = await f.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  expect(scheduled.some((item) => item.scheduledTime === startedAt + 45_000)).toBe(true);
  vi.setSystemTime(startedAt + 45_000);
  await f.t.mutation(internal.findingCommandRequests.dispatch, { requestId });
  expect(await f.receipt()).toMatchObject({ status: "pending", attempts: 1, nextAttemptAt: startedAt + 50_000 });
  await f.t.mutation(internal.findingCommandRequests.finish, { requestId, attempt: 1, outcome: { kind: "authorized" } });
  expect(await f.t.run((ctx) => ctx.db.query("findingCommands").collect())).toHaveLength(0);
  vi.setSystemTime(startedAt + 50_000);
  await f.t.mutation(internal.findingCommandRequests.dispatch, { requestId });
  await f.t.action((ctx) => verifyRequest(ctx, requestId, 2, api.fetcher));
  expect(await f.receipt()).toMatchObject({ status: "done", attempts: 2 });
  expect(await f.t.run((ctx) => ctx.db.query("findingCommands").collect())).toHaveLength(1);
});
