import type { ReviewResult } from "@fred/contracts";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { LEASE_MS } from "./lease";
import schema from "./schema";
import { connectProject, delivery, fixtureBot, modules, testTokenKey } from "./test.setup";

const auth = { workerSecret: "test-worker-secret" };
const request = { ...auth, workerId: "one" };
const trigger = {
  project: { gitlabProjectId: "42", path: "group/repo" }, mrIid: 1, headSha: "A", provider: "fred" as const,
  kind: "push" as const, triggeredBy: "7", budgetOwner: { gitlabUserId: "7" },
};
const emptyResult = { findings: [], findingDecisions: [], effects: [{ key: "summary", kind: "summary", body: "clean", findingIndexes: [] }] } satisfies ReviewResult;
const result = {
  findings: [
    { file: "a.ts", line: 2, title: "bug", body: "details", severity: "blocking", status: "pending" },
    { file: "b.ts", oldLine: 3, title: "discarded", body: "details", severity: "should_fix", status: "rejected", rejectReason: "not confirmed" },
    { file: "c.ts", title: "already raised", body: "details", severity: "nit", status: "duplicate", rejectReason: "human" },
  ], findingDecisions: [], effects: [
    { key: "summary", kind: "summary", body: "summary", findingIndexes: [0] },
    { key: "finding:0", kind: "finding", findingIndex: 0, body: "bug" },
    { key: "label", kind: "label", label: "fred-review::findings", removeLabel: "fred-review::clean" },
  ],
} satisfies ReviewResult;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-01T10:00:00Z"));
  vi.stubEnv("WORKER_SECRET", auth.workerSecret);
  vi.stubEnv("FRED_TOKEN_KEY", testTokenKey);
  vi.stubEnv("FRED_MAINTENANCE_MODE", undefined);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

async function setup() {
  const t = convexTest(schema, modules);
  await t.run((ctx) => ctx.db.insert("settings", { globalEnabled: true, defaultBudgetUsd: 3000, orgTimezone: "Europe/Berlin" }));
  await connectProject(t, trigger.project);
  return t;
}
async function running(t: Awaited<ReturnType<typeof setup>>) {
  await t.mutation(internal.enqueue.enqueue, { ...trigger, ...delivery() });
  const job = await t.mutation(api.jobs.claim, request);
  if (job?.kind !== "review") throw new Error("expected a claimed job");
  return { job, lease: { ...auth, jobId: job._id, leaseToken: job.leaseToken } };
}

function usage(lease: Awaited<ReturnType<typeof running>>["lease"]) {
  return { ...lease, eventKey: "detect:1", provider: "fred" as const, model: "m", stage: "detect" as const,
    inputTokens: 10, cachedInputTokens: 2, outputTokens: 3, costUsd: 0.42, priceTableVersion: "test" };
}

describe("claim and leases", () => {
  it("atomically gives two workers one job", async () => {
    const t = await setup();
    await t.mutation(internal.enqueue.enqueue, { ...trigger, ...delivery() });
    const claimed = await Promise.all([t.mutation(api.jobs.claim, request), t.mutation(api.jobs.claim, { ...request, workerId: "two" })]);
    expect(claimed.filter(Boolean)).toHaveLength(1);
  });

  it("serializes reviews on one MR while allowing a different MR", async () => {
    const t = await setup();
    const { job, lease } = await running(t);
    await t.mutation(internal.enqueue.enqueue, { ...delivery(), ...trigger, headSha: "B" });
    await t.mutation(internal.enqueue.enqueue, { ...delivery(), ...trigger, mrIid: 2 });
    expect(await t.mutation(api.jobs.claim, request)).toMatchObject({ mrIid: 2 });
    expect(await t.mutation(api.jobs.claim, request)).toBeNull();
    await t.mutation(api.jobs.fail, { ...lease, failureReason: "error" });
    expect(await t.mutation(api.jobs.claim, request)).toMatchObject({ mrIid: job.mrIid, headSha: "B", provider: "fred" });
  });

  it("claims FRED work on an MR whose retired-bot publication no worker will finish", async () => {
    const t = await setup();
    await t.run(async (ctx) => {
      const project = await ctx.db.query("projects").withIndex("by_gitlab_project", (q) => q.eq("gitlabProjectId", trigger.project.gitlabProjectId)).unique();
      const developerId = await ctx.db.insert("developers", { gitlabUserId: "7" });
      await ctx.db.insert("reviewJobs", { projectId: project!._id, developerId, provider: "codex", status: "publishing", mrIid: 1, headSha: "OLD",
        triggeredBy: "7", resultJson: JSON.stringify(emptyResult), leaseExpiresAt: 0 });
    });
    await t.mutation(internal.enqueue.enqueue, { ...trigger, ...delivery() });
    expect(await t.mutation(api.jobs.claim, request)).toMatchObject({ mrIid: 1, provider: "fred", status: "running" });
  });

  it("hands the worker the project's opened token and FRED bot users only through claim", async () => {
    const t = await setup();
    await t.mutation(internal.enqueue.enqueue, { ...trigger, ...delivery() });
    const queued = await t.query(api.jobs.listQueued, auth);
    expect(queued).toHaveLength(1);
    expect(JSON.stringify(queued)).not.toContain(fixtureBot.token);
    expect(await t.mutation(api.jobs.claim, request)).toMatchObject({
      provider: "fred", gitlabToken: fixtureBot.token, gitlabBotUserId: fixtureBot.botUserId, gitlabBotUserIds: [fixtureBot.botUserId],
    });
  });

  it("exposes abandoned analysis leases so a restarted subscriber can claim a queued successor at expiry", async () => {
    const t = await setup();
    const { job } = await running(t);
    await t.mutation(internal.enqueue.enqueue, { ...delivery(), ...trigger, headSha: "B" });
    const queued = await t.query(api.jobs.listQueued, auth);
    expect(queued).toMatchObject([{ _id: job._id, status: "running", leaseExpiresAt: job.leaseExpiresAt }, { provider: "fred", status: "queued" }]);
    expect(await t.mutation(api.jobs.claim, { ...request, workerId: "restarted" })).toBeNull();
    vi.setSystemTime(job.leaseExpiresAt);
    expect(await t.mutation(api.jobs.claim, { ...request, workerId: "restarted" })).toMatchObject({ headSha: "B", status: "running" });
    expect(await t.run((ctx) => ctx.db.get(job._id))).toMatchObject({ status: "failed", failureReason: "stale" });
  });

  it("rechecks policy at claim and continues to another developer", async () => {
    const t = await setup();
    await t.mutation(internal.enqueue.enqueue, { ...trigger, ...delivery() });
    await t.mutation(internal.enqueue.enqueue, { ...delivery(), ...trigger, mrIid: 2, budgetOwner: { gitlabUserId: "8" } });
    await t.run(async (ctx) => {
      const developer = await ctx.db.query("developers").withIndex("by_gitlab_user", (q) => q.eq("gitlabUserId", "7")).unique();
      await ctx.db.patch(developer!._id, { blocked: true });
    });
    expect(await t.mutation(api.jobs.claim, request)).toMatchObject({ mrIid: 2 });
    expect(await t.run((ctx) => ctx.db.query("mrNotes").collect())).toHaveLength(1);
  });

  it("declines queued analysis during maintenance and permits a fresh reviewer addition after clearing it", async () => {
    const t = await setup();
    const enqueue = (deliveryKey: string) => t.mutation(internal.enqueue.enqueue, {
      ...trigger, kind: "reviewer_added", deliveryKey,
    });
    const queued = await enqueue("before-maintenance");
    if (queued.result !== "queued") throw new Error("expected a queued job");

    vi.stubEnv("FRED_MAINTENANCE_MODE", "true");
    expect(await t.mutation(api.jobs.claim, request)).toBeNull();
    const reason = "FRED is currently under maintenance. Please request a review again once maintenance is complete.";
    expect(await t.run((ctx) => ctx.db.get(queued.jobId))).toMatchObject({ status: "denied", denialReason: reason });
    expect(await t.run((ctx) => ctx.db.query("mrNotes").collect())).toMatchObject([
      { provider: "fred", body: `AI review not run: ${reason}`, status: "pending" },
    ]);
    expect(await enqueue("during-maintenance")).toEqual({ result: "denied", reason });

    vi.stubEnv("FRED_MAINTENANCE_MODE", undefined);
    expect(await enqueue("before-maintenance")).toEqual({ result: "duplicate" });
    expect(await enqueue("during-maintenance")).toEqual({ result: "duplicate" });
    expect(await t.mutation(api.jobs.claim, request)).toBeNull();
    expect(await enqueue("after-maintenance")).toMatchObject({ result: "queued" });
    expect(await t.mutation(api.jobs.claim, request)).toMatchObject({ provider: "fred", headSha: trigger.headSha, status: "running" });
    expect(await t.run((ctx) => ctx.db.get(queued.jobId))).toMatchObject({ status: "denied" });
  });

  it("heartbeat extends an active lease and cannot revive an expired one", async () => {
    const t = await setup();
    const { lease, job } = await running(t);
    vi.setSystemTime(Date.now() + 60_000);
    const heartbeat = await t.mutation(api.jobs.heartbeat, lease);
    expect(heartbeat.leaseExpiresAt).toBeGreaterThan(job.leaseExpiresAt);
    vi.setSystemTime(heartbeat.leaseExpiresAt);
    await expect(t.mutation(api.jobs.heartbeat, lease)).rejects.toThrow(/lease lost/);
  });

  it("fails expired analysis once, marks accounting incomplete, and never reruns it", async () => {
    const t = await setup();
    const { job, lease } = await running(t);
    vi.setSystemTime(Date.now() + LEASE_MS);
    expect(await t.mutation(internal.stale.failStale, {})).toBe(1);
    expect(await t.mutation(internal.stale.failStale, {})).toBe(0);
    expect(await t.mutation(api.jobs.claim, request)).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(job._id))).toMatchObject({ status: "failed", failureReason: "stale", usageIncomplete: true });
    expect(await t.run((ctx) => ctx.db.query("mrNotes").collect())).toHaveLength(1);
    await expect(t.mutation(api.jobs.saveResult, { ...lease, resultJson: JSON.stringify(result) })).rejects.toThrow(/lease lost/);
  });
});

describe("durable publication", () => {
  it("saves every validator outcome once before external effects", async () => {
    const t = await setup();
    const { lease } = await running(t);
    await t.mutation(api.jobs.saveResult, { ...lease, resultJson: JSON.stringify(result) });
    await t.mutation(api.jobs.saveResult, { ...lease, resultJson: JSON.stringify(result) });
    const findings = await t.run((ctx) => ctx.db.query("findings").collect());
    expect(findings.map((finding) => finding.status)).toEqual(["pending", "rejected", "duplicate"]);
    expect(findings[1]).toMatchObject({ oldLine: 3 });
    await expect(t.mutation(api.jobs.saveResult, { ...lease, resultJson: JSON.stringify(emptyResult) })).rejects.toThrow(/immutable/);
    await expect(t.mutation(api.jobs.complete, lease)).rejects.toThrow(/incomplete/);
  });

  it("reclaims only publication, retains acknowledged effects, and fences the old worker", async () => {
    const t = await setup();
    const { lease } = await running(t);
    await t.mutation(api.jobs.saveResult, { ...lease, resultJson: JSON.stringify(result) });
    await t.mutation(api.jobs.ackPublication, { ...lease, effectKey: "summary" });
    await t.mutation(api.jobs.ackPublication, { ...lease, effectKey: "finding:0", discussionId: "d1" });
    vi.setSystemTime(Date.now() + LEASE_MS);
    await t.mutation(internal.stale.failStale, {});
    const recovered = await t.mutation(api.jobs.claim, { ...request, workerId: "two" });
    expect(recovered).toMatchObject({ status: "publishing", publicationAcks: [{ key: "summary" }, { key: "finding:0", discussionId: "d1" }] });
    expect(JSON.parse(recovered!.resultJson!)).toEqual(result);
    expect(recovered?.leaseToken).not.toBe(lease.leaseToken);
    await expect(t.mutation(api.jobs.ackPublication, { ...lease, effectKey: "summary" })).rejects.toThrow(/lease lost/);
    await expect(t.mutation(api.jobs.fail, { ...lease, failureReason: "error" })).rejects.toThrow(/lease lost/);
    await expect(t.mutation(api.jobs.recordUsage, usage(lease))).rejects.toThrow(/lease lost/);
    if (recovered?.kind !== "review") throw new Error("expected recovery");
    const newLease = { ...lease, leaseToken: recovered.leaseToken };
    await t.mutation(api.jobs.ackPublication, { ...newLease, effectKey: "label" });
    await t.mutation(api.jobs.complete, newLease);
    await t.mutation(api.jobs.complete, newLease);
    expect(await t.run((ctx) => ctx.db.get(lease.jobId))).toMatchObject({ status: "done" });
  });

  it.each([false, true])("preserves finding visibility when superseded after summary acknowledged=%s", async (summaryPosted) => {
    const t = await setup();
    const { lease } = await running(t);
    await t.mutation(api.jobs.saveResult, { ...lease, resultJson: JSON.stringify(result) });
    if (summaryPosted) await t.mutation(api.jobs.ackPublication, { ...lease, effectKey: "summary" });
    await t.mutation(api.jobs.supersede, lease);
    const findings = await t.run((ctx) => ctx.db.query("findings").collect());
    expect(findings).toHaveLength(3);
    expect(findings[0]?.status).toBe(summaryPosted ? "posted" : "pending");
    expect(findings[0]?.discussionId).toBeUndefined();
    expect(await t.run((ctx) => ctx.db.query("mrNotes").collect())).toHaveLength(0);
  });

  it("checks effect order and makes each acknowledgement idempotent", async () => {
    const t = await setup();
    const { lease } = await running(t);
    await t.mutation(api.jobs.saveResult, { ...lease, resultJson: JSON.stringify(result) });
    await expect(t.mutation(api.jobs.ackPublication, { ...lease, effectKey: "label" })).rejects.toThrow(/in order/);
    await t.mutation(api.jobs.ackPublication, { ...lease, effectKey: "summary" });
    expect(await t.run((ctx) => ctx.db.query("findings").collect())).toMatchObject([{ status: "posted" }, { status: "rejected" }, { status: "duplicate" }]);
    await t.mutation(api.jobs.ackPublication, { ...lease, effectKey: "finding:0", discussionId: "d1" });
    await t.mutation(api.jobs.ackPublication, { ...lease, effectKey: "finding:0", discussionId: "d1" });
    await expect(t.mutation(api.jobs.ackPublication, { ...lease, effectKey: "finding:0", discussionId: "d2" })).rejects.toThrow(/changed/);
    await t.mutation(api.jobs.fail, { ...lease, failureReason: "label_missing", message: "missing group label" });
    expect(await t.run((ctx) => ctx.db.query("findings").collect())).toMatchObject([{ status: "posted", discussionId: "d1" }, { status: "rejected" }, { status: "duplicate" }]);
    expect(await t.run((ctx) => ctx.db.query("mrNotes").collect())).toMatchObject([{ body: `AI review failed: missing group label. Remove and re-add this reviewer to retry (job ${lease.jobId})` }]);
  });
});

describe("usage snapshots", () => {
  it("deduplicates identical observations and rejects conflicting replay", async () => {
    const t = await setup();
    const { lease } = await running(t);
    const event = usage(lease);
    const first = await t.mutation(api.jobs.recordUsage, event);
    expect(await t.mutation(api.jobs.recordUsage, event)).toBe(first);
    await expect(t.mutation(api.jobs.recordUsage, { ...event, costUsd: 1 })).rejects.toThrow(/reused/);
    expect(await t.run((ctx) => ctx.db.query("usageEvents").collect())).toMatchObject([{ month: "2026-09", day: "2026-09-01", costUsd: 0.42, rolledUp: true }]);
    expect(await t.run((ctx) => ctx.db.query("usageDaily").collect())).toMatchObject([
      { day: "2026-09-01", provider: "fred", model: "m", costMicroUsd: 420_000, inputTokens: 10, cachedInputTokens: 2, outputTokens: 3, reviews: 1 },
    ]);
    expect(await t.run((ctx) => ctx.db.query("usageMonthly").collect())).toMatchObject([{ month: "2026-09", costMicroUsd: 420_000, inputTokens: 10, reviews: 1 }]);
  });

  it("counts a job as one review on its first priced row and adds later rows to the same rollups", async () => {
    const t = await setup();
    const { lease } = await running(t);
    await t.mutation(api.jobs.recordUsage, usage(lease));
    expect(await t.run((ctx) => ctx.db.get(lease.jobId))).toMatchObject({ firstUsageDay: "2026-09-01" });
    await t.mutation(api.jobs.recordUsage, { ...usage(lease), eventKey: "validate:1", stage: "validate", costUsd: 0.08, inputTokens: 5 });
    await t.mutation(api.jobs.recordUsage, { ...usage(lease), eventKey: "validate:2", stage: "validate", model: "other", costUsd: 0.5 });
    expect(await t.run((ctx) => ctx.db.query("usageDaily").collect())).toMatchObject([
      { model: "m", costMicroUsd: 500_000, inputTokens: 15, reviews: 1 },
      { model: "other", costMicroUsd: 500_000, inputTokens: 10, reviews: 0 },
    ]);
    expect(await t.run((ctx) => ctx.db.query("usageMonthly").collect())).toMatchObject([{ month: "2026-09", costMicroUsd: 1_000_000, inputTokens: 25, reviews: 1 }]);
  });

  it("rejects invalid amounts and provider mismatches before insertion", async () => {
    const t = await setup();
    const { lease } = await running(t);
    for (const invalid of [{ inputTokens: -1 }, { outputTokens: 1.5 }, { costUsd: -1 }, { costUsd: Infinity }, { provider: "claude" as const }]) {
      await expect(t.mutation(api.jobs.recordUsage, { ...usage(lease), ...invalid })).rejects.toThrow();
    }
    expect(await t.run((ctx) => ctx.db.query("usageEvents").collect())).toHaveLength(0);
  });

  it("keeps explicit accounting gaps after both stage confirmations and allows the terminal owner to flush", async () => {
    const t = await setup();
    const { lease } = await running(t);
    await t.mutation(api.jobs.markUsageIncomplete, { ...lease, reason: "snapshot regressed" });
    await t.mutation(api.jobs.confirmUsage, { ...lease, stage: "detect" });
    await t.mutation(api.jobs.confirmUsage, { ...lease, stage: "validate" });
    await t.mutation(api.jobs.fail, { ...lease, failureReason: "timeout" });
    await t.mutation(api.jobs.recordUsage, usage(lease));
    expect(await t.run((ctx) => ctx.db.get(lease.jobId))).toMatchObject({ usageIncomplete: true, usageConfirmedStages: ["detect", "validate"] });
  });
});

it("an ambiguous result-save interruption preserves publishing but fails unfinished analysis", async () => {
  const t = await setup();
  const { lease } = await running(t);
  await t.mutation(api.jobs.saveResult, { ...lease, resultJson: JSON.stringify(result) });
  await t.mutation(api.jobs.interruptAnalysis, { ...lease, message: "connection lost" });
  expect(await t.run((ctx) => ctx.db.get(lease.jobId))).toMatchObject({ status: "publishing" });
  expect(await t.run((ctx) => ctx.db.query("mrNotes").collect())).toHaveLength(0);
  await t.mutation(api.jobs.supersede, lease);
  await t.mutation(internal.enqueue.enqueue, { ...delivery(), ...trigger, headSha: "B" });
  const job = await t.mutation(api.jobs.claim, request);
  if (job?.kind !== "review") throw new Error("expected next job");
  vi.setSystemTime(Date.now() + LEASE_MS);
  await t.mutation(api.jobs.interruptAnalysis, { ...auth, jobId: job._id, leaseToken: job.leaseToken });
  await t.mutation(api.jobs.interruptAnalysis, { ...auth, jobId: job._id, leaseToken: job.leaseToken });
  expect(await t.run((ctx) => ctx.db.get(job._id))).toMatchObject({ status: "failed", usageIncomplete: true });
  expect(await t.run((ctx) => ctx.db.query("mrNotes").collect())).toHaveLength(1);
});

describe.each(["analysis", "publication"])("creation after failed %s", (phase) => {
  it("does not recover work even with a fresh delivery key", async () => {
    const t = await setup();
    const { job, lease } = await running(t);
    if (phase === "publication") {
      await t.mutation(api.jobs.saveResult, { ...lease, resultJson: JSON.stringify(emptyResult) });
    }
    await t.mutation(api.jobs.fail, { ...lease, failureReason: "error" });
    const failed = await t.run((ctx) => ctx.db.get(job._id));
    expect(await t.mutation(internal.enqueue.enqueue, {
      ...trigger, kind: "mr_opened", deliveryKey: "delayed-creation",
    })).toEqual({ result: "duplicate" });
    expect(await t.run((ctx) => ctx.db.query("reviewJobs").collect())).toEqual([failed]);
  });
});

describe("deliberate failed-review recovery", () => {
  it("creates fresh analysis attempts, preserves history, and deduplicates deliveries and outstanding work", async () => {
    const t = await setup();
    const first = await running(t);
    await t.mutation(api.jobs.fail, { ...first.lease, failureReason: "error" });
    const retry = (deliveryKey: string) => t.mutation(internal.enqueue.enqueue, { ...trigger, kind: "reviewer_added", deliveryKey });
    expect(await retry("first-retry")).toMatchObject({ result: "queued" });
    expect(await retry("first-retry")).toEqual({ result: "duplicate" });
    expect(await retry("while-queued")).toEqual({ result: "duplicate" });
    const second = await t.mutation(api.jobs.claim, request);
    if (second?.kind !== "review") throw new Error("expected a claimed review");
    expect(second._id).not.toBe(first.job._id);
    expect(second.resultJson).toBeUndefined();
    await t.mutation(api.jobs.fail, { ...auth, jobId: second._id, leaseToken: second.leaseToken, failureReason: "error" });
    expect(await retry("second-retry")).toMatchObject({ result: "queued" });
    expect(await retry("while-queued")).toEqual({ result: "duplicate" });
    const jobs = await t.run((ctx) => ctx.db.query("reviewJobs").collect());
    expect(jobs.map((job) => job.status)).toEqual(["failed", "failed", "queued"]);
    expect(await t.run((ctx) => ctx.db.query("mrNotes").collect())).toHaveLength(2);
  });

  it("deduplicates an outstanding attempt even when a newer failed attempt exists", async () => {
    const t = await setup();
    const { job } = await running(t);
    await t.run(async (ctx) => {
      const { _id, _creationTime, ...fields } = (await ctx.db.get(job._id))!;
      await ctx.db.insert("reviewJobs", { ...fields, status: "failed" });
    });
    expect(await t.mutation(internal.enqueue.enqueue, { ...trigger, kind: "reviewer_added", deliveryKey: "older-outstanding" }))
      .toEqual({ result: "duplicate" });
  });

  it("resumes publication under fresh ownership after its MR sibling finishes", async () => {
    const t = await setup();
    const { job, lease } = await running(t);
    const stored = JSON.stringify({ ...emptyResult, effects: [...emptyResult.effects,
      { key: "label", kind: "label", label: "fred-review::clean", removeLabel: "fred-review::findings" }] });
    await t.mutation(api.jobs.recordUsage, usage(lease));
    await t.mutation(api.jobs.saveResult, { ...lease, resultJson: stored });
    await t.mutation(api.jobs.ackPublication, { ...lease, effectKey: "summary" });
    await t.mutation(api.jobs.fail, { ...lease, failureReason: "error", message: "publication rejected" });
    await t.mutation(internal.enqueue.enqueue, { ...delivery(), ...trigger, headSha: "B" });
    const sibling = await t.mutation(api.jobs.claim, request);
    if (sibling?.kind !== "review") throw new Error("expected a claimed review");
    const retry = (deliveryKey: string) => t.mutation(internal.enqueue.enqueue, { ...trigger, kind: "reviewer_added", deliveryKey });
    expect(await retry("recover-1")).toEqual({ result: "queued", jobId: job._id });
    await expect(t.mutation(api.jobs.heartbeat, lease)).rejects.toThrow(/lease lost/);
    await expect(t.mutation(api.jobs.recordUsage, usage(lease))).rejects.toThrow(/lease lost/);
    expect(await t.mutation(api.jobs.claim, request)).toBeNull();
    await t.mutation(api.jobs.fail, { ...auth, jobId: sibling._id, leaseToken: sibling.leaseToken, failureReason: "error" });
    const recovered = await t.mutation(api.jobs.claim, { ...request, workerId: "recovered" });
    expect(recovered).toMatchObject({ _id: job._id, status: "publishing", publicationAcks: [{ key: "summary" }] });
    expect(JSON.parse(recovered!.resultJson!)).toEqual(JSON.parse(stored));
    const owner = { ...auth, jobId: job._id, leaseToken: recovered!.leaseToken };
    await t.mutation(api.jobs.fail, { ...owner, failureReason: "error", message: "publication still rejected" });
    const notes = await t.run((ctx) => ctx.db.query("mrNotes").withIndex("by_job", (q) => q.eq("jobId", job._id)).collect());
    expect(notes).toHaveLength(2);
    expect(new Set(notes.map((note) => note.key)).size).toBe(2);
    expect(notes.every((note) => note.failureJson !== undefined)).toBe(true);
    expect(await retry("recover-2")).toEqual({ result: "queued", jobId: job._id });
    const final = await t.mutation(api.jobs.claim, request);
    const finalOwner = { ...auth, jobId: job._id, leaseToken: final!.leaseToken };
    await t.mutation(api.jobs.ackPublication, { ...finalOwner, effectKey: "label" });
    await t.mutation(api.jobs.complete, finalOwner);
    expect(await t.run((ctx) => ctx.db.query("usageEvents").collect())).toHaveLength(1);
    expect(await retry("after-completion")).toEqual({ result: "duplicate" });
  });

  it("rechecks policy before reopening failed publication and preserves it on denial", async () => {
    const t = await setup();
    const { job, lease } = await running(t);
    await t.mutation(api.jobs.saveResult, { ...lease, resultJson: JSON.stringify(emptyResult) });
    await t.mutation(api.jobs.fail, { ...lease, failureReason: "error" });
    const enabled = (globalEnabled: boolean) => t.run(async (ctx) => {
      const settings = await ctx.db.query("settings").first();
      await ctx.db.patch(settings!._id, { globalEnabled });
    });
    const retry = (deliveryKey: string) => t.mutation(internal.enqueue.enqueue, { ...trigger, kind: "reviewer_added", deliveryKey });
    await enabled(false);
    expect(await retry("blocked")).toEqual({ result: "denied", reason: "disabled" });
    expect(await t.run((ctx) => ctx.db.get(job._id))).toMatchObject({ status: "failed", resultJson: JSON.stringify(emptyResult) });
    await enabled(true);
    expect(await retry("blocked")).toEqual({ result: "duplicate" });
    expect(await retry("unblocked")).toEqual({ result: "queued", jobId: job._id });
  });

  it("checks the saved publication owner's policy when another actor retries", async () => {
    const t = await setup();
    const { job, lease } = await running(t);
    await t.mutation(api.jobs.saveResult, { ...lease, resultJson: JSON.stringify(emptyResult) });
    await t.mutation(api.jobs.fail, { ...lease, failureReason: "error" });
    await t.run((ctx) => ctx.db.patch(job.developerId, { blocked: true }));
    const retry = (deliveryKey: string) => t.mutation(internal.enqueue.enqueue, { ...trigger,
      kind: "reviewer_added", deliveryKey, budgetOwner: { gitlabUserId: "different-actor" } });
    expect(await retry("owner-blocked")).toMatchObject({ result: "denied" });
    expect(await t.run((ctx) => ctx.db.get(job._id))).toMatchObject({ status: "failed", developerId: job.developerId });
    await t.run((ctx) => ctx.db.patch(job.developerId, { blocked: false }));
    expect(await retry("owner-unblocked")).toEqual({ result: "queued", jobId: job._id });
  });

  it("expires bounded lease batches and legacy deadlines while preserving healthy ownership", async () => {
    const t = await setup();
    const { job, lease } = await running(t);
    const ids = await t.run(async (ctx) => {
      const { _id, _creationTime, ...fields } = (await ctx.db.get(job._id))!;
      return Promise.all(Array.from({ length: 40 }, (_, i) => ctx.db.insert("reviewJobs", {
        ...fields, mrIid: i + 2, leaseExpiresAt: Date.now() - 1,
      })));
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(ids[39]!, { leaseExpiresAt: undefined, deadlineAt: Date.now() - 1 });
    });
    expect(await t.mutation(internal.stale.failStale, {})).toBe(32);
    expect(await t.mutation(internal.stale.failStale, {})).toBe(8);
    expect(await t.mutation(internal.stale.failStale, {})).toBe(0);
    await expect(t.mutation(api.jobs.heartbeat, lease)).resolves.toMatchObject({ leaseExpiresAt: Date.now() + LEASE_MS });
    expect(await t.run((ctx) => ctx.db.query("mrNotes").collect())).toHaveLength(40);
  });
});

it("a skipped review ends without a result and still supplies the next incremental baseline", async () => {
  const t = await setup();
  const { lease } = await running(t);
  expect(await t.mutation(api.jobs.skip, lease)).toEqual({ skipped: true });
  const skipped = await t.run((ctx) => ctx.db.get(lease.jobId));
  expect(skipped).toMatchObject({ status: "skipped" });
  expect(skipped?.resultJson).toBeUndefined();
  await t.mutation(internal.enqueue.enqueue, { ...delivery(), ...trigger, headSha: "B" });
  expect(await t.mutation(api.jobs.claim, request)).toMatchObject({ kind: "review", headSha: "B", previousReviewedSha: "A" });
});

it("refuses to skip while a finding posted by a review that never completed stays open", async () => {
  const t = await setup();
  const { lease } = await running(t);
  await t.mutation(api.jobs.saveResult, { ...lease, resultJson: JSON.stringify(result) });
  await t.mutation(api.jobs.ackPublication, { ...lease, effectKey: "summary" });
  await t.mutation(api.jobs.supersede, lease);
  await t.mutation(internal.enqueue.enqueue, { ...delivery(), ...trigger, headSha: "B" });
  const next = await t.mutation(api.jobs.claim, request);
  if (next?.kind !== "review") throw new Error("expected next job");
  expect(await t.mutation(api.jobs.skip, { ...auth, jobId: next._id, leaseToken: next.leaseToken })).toEqual({ skipped: false });
  expect(await t.run((ctx) => ctx.db.get(next._id))).toMatchObject({ status: "running" });
});
