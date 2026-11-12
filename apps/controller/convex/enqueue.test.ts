import { diagnosticEvent } from "@fred/contracts";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pushWhileAssigned from "../../../fixtures/webhooks/push-while-assigned.json";
import reRequested from "../../../fixtures/webhooks/re-requested.json";
import reviewerAdded from "../../../fixtures/webhooks/reviewer-added.json";
import type { Id } from "./_generated/dataModel";
import { monthOf } from "./month";
import schema from "./schema";
import { connectProject, fixtureProject, modules, testTokenKey } from "./test.setup";

const secret = "hook-secret";
const orgTimezone = "Europe/Berlin";
const mrOpened = {
  ...pushWhileAssigned,
  object_attributes: { ...pushWhileAssigned.object_attributes, action: "open", oldrev: null },
  changes: {},
};

// Seeds settings and connects the fixture project, so webhooks for it queue reviews.
function setup(settings: { globalEnabled: boolean } = { globalEnabled: true }) {
  const t = convexTest(schema, modules);
  const seeded = t.run((ctx) => ctx.db.insert("settings", { ...settings, defaultBudgetUsd: 3000, orgTimezone })).then(() => connectProject(t));
  return { t, seeded };
}

function post(t: ReturnType<typeof convexTest>, body: unknown, token = secret, deliveryKey?: string) {
  return t.fetch("/webhook/gitlab", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Gitlab-Token": token, ...(deliveryKey ? { "Idempotency-Key": deliveryKey } : {}) },
    body: JSON.stringify(body),
  });
}

// Fake timers keep the scheduled postMrNote from firing; the tests assert the
// delivery row, not the GitLab call.
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("GITLAB_WEBHOOK_SECRET", secret);
  vi.stubEnv("FRED_TOKEN_KEY", testTokenKey);
  vi.stubEnv("FRED_MAINTENANCE_MODE", undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("POST /webhook/gitlab", () => {
  it("refreshes stored display names, preserves them when omitted, and clears blank names", async () => {
    const { t, seeded } = setup();
    await seeded;
    for (const [name, expected] of [["  Daniel Kistner  ", "Daniel Kistner"], ["Daniel K.", "Daniel K."],
      [undefined, "Daniel K."], ["   ", undefined]] as const) {
      const response = await post(t, { ...reviewerAdded, user: { ...reviewerAdded.user, name } });
      expect(response.status).toBe(200);
      const developers = await t.run((ctx) => ctx.db.query("developers").collect());
      expect(developers).toHaveLength(1);
      expect(developers[0]?.displayName).toBe(expected);
    }
  });

  it("rejects a wrong token before reading the body", async () => {
    const { t } = setup();
    const response = await post(t, reviewerAdded, "nope");
    expect(response.status).toBe(401);
  });

  it("reviewer added queues one job with the project's pipeline and upserts project and developer", async () => {
    const { t, seeded } = setup();
    const projectId = await seeded;
    const pipeline = { detect: { model: "anthropic/claude-fable-5.1", effort: "high" }, validate: { model: "openai/gpt-6-astra", effort: "low" } };
    await t.run((ctx) => ctx.db.patch(projectId, { stageModels: pipeline }));
    const response = await post(t, reviewerAdded);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ provider: "fred", kind: "reviewer_added", result: "queued", jobId: expect.any(String) });

    const rows = await t.run(async (ctx) => ({
      jobs: await ctx.db.query("reviewJobs").collect(),
      projects: await ctx.db.query("projects").collect(),
      developers: await ctx.db.query("developers").collect(),
    }));
    expect(rows.projects).toMatchObject([{ gitlabProjectId: "7", path: "frei/flight-management" }]);
    expect(rows.developers).toMatchObject([{ gitlabUserId: "42", username: "daniel" }]);
    expect(rows.jobs).toMatchObject([
      {
        mrIid: 16,
        headSha: "e59094b8de0f2f91abbe4760a52d9137260252d8",
        provider: "fred",
        stageModels: pipeline,
        status: "queued",
        triggeredBy: "42",
        projectId: rows.projects[0]?._id,
        developerId: rows.developers[0]?._id,
      },
    ]);
    expect(rows.jobs[0]).not.toHaveProperty("previousReviewedSha");
  });

  it("a duplicate delivery is ignored", async () => {
    const { t, seeded } = setup();
    await seeded;
    await post(t, reviewerAdded);
    const second = await post(t, reviewerAdded);
    expect(await second.json()).toMatchObject({ result: "duplicate" });
    expect(await t.run((ctx) => ctx.db.query("reviewJobs").collect())).toHaveLength(1);
  });

  it.each([undefined, "creation-delivery"])("creation queues one review once with delivery key %s", async (deliveryKey) => {
    const { t, seeded } = setup();
    await seeded;
    const first = await post(t, mrOpened, secret, deliveryKey);
    expect(await first.json()).toMatchObject({ provider: "fred", kind: "mr_opened", result: "queued" });
    for (const key of [deliveryKey, "another-creation-delivery"]) {
      const duplicate = await post(t, mrOpened, secret, key);
      expect(await duplicate.json()).toMatchObject({ provider: "fred", result: "duplicate" });
    }
    const headSha = mrOpened.object_attributes.last_commit.id;
    expect(await t.run((ctx) => ctx.db.query("reviewJobs").collect())).toMatchObject([
      { provider: "fred", status: "queued", mrIid: 16, headSha },
    ]);
  });

  it("ignores a project that is not connected and records why", async () => {
    const t = convexTest(schema, modules);
    await t.run((ctx) => ctx.db.insert("settings", { globalEnabled: true, defaultBudgetUsd: 3000, orgTimezone }));
    expect(await (await post(t, reviewerAdded)).json()).toEqual({ ignored: true, reason: "project not connected to FRED" });
    expect(await t.run((ctx) => ctx.db.query("reviewJobs").collect())).toHaveLength(0);
    const events = (await t.run((ctx) => ctx.db.query("diagnosticEvents").collect())).map((row) => diagnosticEvent.parse(JSON.parse(row.eventJson)));
    expect(events).toContainEqual(expect.objectContaining({ kind: "webhook_ignored", reason: "unconfigured" }));
  });

  it.each([
    { kind: "creation", body: mrOpened },
    { kind: "push", body: pushWhileAssigned },
  ])("an MR authored by another project's FRED bot does not trigger on $kind", async ({ body }) => {
    const { t, seeded } = setup();
    await seeded;
    await connectProject(t, { gitlabProjectId: "8", path: "frei/other" }, { botUserId: "801", token: "glpat-other" });
    const botAuthored = { ...body, object_attributes: { ...body.object_attributes, author_id: 801 } };
    expect(await (await post(t, botAuthored)).json()).toEqual({ ignored: true });
    expect(await t.run((ctx) => ctx.db.query("reviewJobs").collect())).toHaveLength(0);
  });

  it("bot-created MRs wait for a human reviewer addition and charge that human", async () => {
    const { t, seeded } = setup();
    await seeded;
    vi.stubEnv("BOT_USER_IDS_OTHER", "300");
    const botCreated = {
      ...mrOpened,
      user: { id: 300, username: "automation-bot" },
      object_attributes: { ...mrOpened.object_attributes, author_id: 300 },
    };
    expect(await (await post(t, botCreated)).json()).toEqual({ ignored: true });
    expect(await t.run((ctx) => ctx.db.query("reviewJobs").collect())).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query("developers").collect())).toHaveLength(0);

    const humanAdded = {
      ...botCreated,
      user: reviewerAdded.user,
      object_attributes: { ...botCreated.object_attributes, action: "update" },
      changes: { reviewers: { previous: [], current: botCreated.reviewers } },
    };
    expect(await (await post(t, humanAdded)).json()).toMatchObject({ provider: "fred", kind: "reviewer_added", result: "queued" });
    const developers = await t.run((ctx) => ctx.db.query("developers").collect());
    expect(developers).toMatchObject([{ gitlabUserId: "42", username: "daniel" }]);
    expect(await t.run((ctx) => ctx.db.query("reviewJobs").collect())).toMatchObject([
      { provider: "fred", developerId: developers[0]!._id, triggeredBy: "42" },
    ]);
  });

  it("a push supersedes queued jobs and queues one for the assigned bot", async () => {
    const { t, seeded } = setup();
    const projectId = await seeded;
    const oldSha = "e59094b8de0f2f91abbe4760a52d9137260252d8";
    const seededIds = await t.run(async (ctx) => {
      const developerId = await ctx.db.insert("developers", { gitlabUserId: "42", username: "daniel" });
      const job = (status: "done" | "queued" | "running", headSha: string) =>
        ctx.db.insert("reviewJobs", { projectId, mrIid: 16, headSha, provider: "fred", status, developerId, triggeredBy: "42" });
      return {
        done: await job("done", oldSha),
        queuedFirst: await job("queued", "1111111111111111111111111111111111111111"),
        queuedSecond: await job("queued", "2222222222222222222222222222222222222222"),
        running: await job("running", "3333333333333333333333333333333333333333"),
      };
    });

    const response = await post(t, pushWhileAssigned);
    expect(await response.json()).toMatchObject({ provider: "fred", kind: "push", result: "queued" });

    const status = (id: Id<"reviewJobs">) => t.run(async (ctx) => (await ctx.db.get(id))?.status);
    expect(await status(seededIds.queuedFirst)).toBe("superseded");
    expect(await status(seededIds.queuedSecond)).toBe("superseded");
    expect(await status(seededIds.running)).toBe("running");
    expect(await status(seededIds.done)).toBe("done");

    const newJobs = await t.run((ctx) =>
      ctx.db
        .query("reviewJobs")
        .filter((q) => q.eq(q.field("status"), "queued"))
        .collect(),
    );
    expect(newJobs.map((j) => j.headSha)).toEqual(["aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00"]);
    for (const job of newJobs) expect(job).not.toHaveProperty("previousReviewedSha");
  });

  it("kill switch off posts one denial comment and inserts no job", async () => {
    const { t, seeded } = setup({ globalEnabled: false });
    await seeded;

    const response = await post(t, reviewerAdded);
    expect(await response.json()).toMatchObject({ result: "denied", reason: "disabled" });

    const state = await t.run(async (ctx) => ({
      jobs: await ctx.db.query("reviewJobs").collect(),
      notes: await ctx.db.query("mrNotes").collect(),
    }));
    expect(state.jobs).toHaveLength(0);
    expect(state.notes).toHaveLength(1);
    expect(state.notes[0]).toMatchObject({
      gitlabProjectId: fixtureProject.gitlabProjectId, mrIid: 16, provider: "fred", body: "AI review not run: disabled", status: "pending",
    });
  });

  it.each([
    { kind: "mr_opened", body: mrOpened },
    { kind: "reviewer_added", body: reviewerAdded },
    { kind: "re_requested", body: reRequested },
    { kind: "push", body: pushWhileAssigned },
  ])("maintenance declines $kind with durable comments, then accepts fresh requests when cleared", async ({ body }) => {
    const { t, seeded } = setup();
    await seeded;
    const reason = "FRED is currently under maintenance. Please request a review again once maintenance is complete.";
    const denied = { provider: "fred", result: "denied", reason };
    const duplicate = { provider: "fred", result: "duplicate" };
    const queued = { provider: "fred", result: "queued" };

    vi.stubEnv("FRED_MAINTENANCE_MODE", "true");
    expect(await (await post(t, body, secret, "maintenance")).json()).toMatchObject(denied);
    expect(await (await post(t, body, secret, "maintenance")).json()).toMatchObject(duplicate);
    expect(await (await post(t, body, secret, "another-request")).json()).toMatchObject(denied);
    expect(await t.run((ctx) => ctx.db.query("reviewJobs").collect())).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query("mrNotes").collect())).toMatchObject([
      { provider: "fred", body: `AI review not run: ${reason}`, status: "pending", attempts: 0 },
    ]);
    const denials = (await t.run((ctx) => ctx.db.query("diagnosticEvents").collect()))
      .map((row) => ({ provider: row.provider, ...diagnosticEvent.parse(JSON.parse(row.eventJson)) }))
      .filter((event) => event.kind === "denied");
    expect(denials).toContainEqual(expect.objectContaining({ provider: "fred", reason: "maintenance" }));

    vi.stubEnv("FRED_MAINTENANCE_MODE", "false");
    expect(await (await post(t, body, secret, "maintenance")).json()).toMatchObject(duplicate);
    expect(await (await post(t, body, secret, "after-maintenance")).json()).toMatchObject(queued);
  });

  it("denied creation schedules one comment and its replay cannot enqueue after enabling reviews", async () => {
    const { t, seeded } = setup({ globalEnabled: false });
    await seeded;
    expect(await (await post(t, mrOpened)).json()).toMatchObject({ provider: "fred", result: "denied", reason: "disabled" });
    await t.run(async (ctx) => {
      const settings = await ctx.db.query("settings").first();
      await ctx.db.patch(settings!._id, { globalEnabled: true });
    });
    expect(await (await post(t, mrOpened)).json()).toEqual({ provider: "fred", kind: "mr_opened", result: "duplicate" });
    const state = await t.run(async (ctx) => ({
      jobs: await ctx.db.query("reviewJobs").collect(),
      notes: await ctx.db.query("mrNotes").collect(),
    }));
    expect(state.jobs).toHaveLength(0);
    expect(state.notes).toMatchObject([
      { provider: "fred", gitlabProjectId: "7", mrIid: 16, body: "AI review not run: disabled", status: "pending" },
    ]);
  });

  it("budget reached denies from the developer's monthly rollup", async () => {
    const { t, seeded } = setup();
    await seeded;
    await t.run(async (ctx) => {
      const developerId = await ctx.db.insert("developers", { gitlabUserId: "42", username: "daniel" });
      await ctx.db.insert("usageMonthly", {
        developerId, month: monthOf(Date.now(), orgTimezone), costMicroUsd: 3000_000_000, inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reviews: 1,
      });
    });

    const response = await post(t, reviewerAdded);
    const body = await response.json();
    expect(body).toMatchObject({ result: "denied" });
    expect(body.reason).toMatch(/^budget reached, 3000\.00 USD of 3000\.00 USD in \d{4}-\d{2}$/);
    expect(await t.run((ctx) => ctx.db.query("reviewJobs").collect())).toHaveLength(0);
  });
});

it("deliberate re-requests deduplicate outstanding work and can rerun completed reviews", async () => {
  const { t, seeded } = setup();
  await seeded;
  const { default: reRequested } = await import("../../../fixtures/webhooks/re-requested.json");
  const request = (key: string) => t.fetch("/webhook/gitlab", {
    method: "POST", headers: { "X-Gitlab-Token": secret, "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(reRequested),
  });
  expect(await (await request("first")).json()).toMatchObject({ result: "queued" });
  expect(await (await request("first")).json()).toMatchObject({ result: "duplicate" });
  expect(await (await request("while-queued")).json()).toMatchObject({ result: "duplicate" });
  await t.run(async (ctx) => {
    const job = await ctx.db.query("reviewJobs").first();
    await ctx.db.patch(job!._id, { status: "done" });
  });
  expect(await (await request("second")).json()).toMatchObject({ result: "queued" });
  expect(await (await request("second")).json()).toMatchObject({ result: "duplicate" });
  const jobs = await t.run((ctx) => ctx.db.query("reviewJobs").collect());
  expect(jobs).toHaveLength(2);
  expect(jobs[0]?.headSha).toBe(jobs[1]?.headSha);
});

it("a denied delivery replay does not become a fresh attempt after a gate opens", async () => {
  const { t, seeded } = setup({ globalEnabled: false });
  await seeded;
  await post(t, reviewerAdded);
  await t.run(async (ctx) => {
    const settings = await ctx.db.query("settings").first();
    await ctx.db.patch(settings!._id, { globalEnabled: true });
  });
  expect(await (await post(t, reviewerAdded)).json()).toMatchObject({ result: "duplicate" });
  expect(await t.run((ctx) => ctx.db.query("reviewJobs").collect())).toHaveLength(0);
});
