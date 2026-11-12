import type { ReviewResult } from "@fred/contracts";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { connectProject, delivery, modules, testTokenKey } from "./test.setup";
import { expireAnalysis } from "./jobLifecycle";
import { LEASE_MS } from "./lease";

const admin = { adminSecret: "admin-test" };
const auth = { workerSecret: "worker-test" };
const claim = { ...auth, workerId: "test" };
const trigger = { provider: "fred" as const, kind: "reviewer_added" as const, deliveryKey: "d1", headSha: "A", mrIid: 1,
  project: { gitlabProjectId: "7", path: "group/a" }, triggeredBy: "42", budgetOwner: { gitlabUserId: "42", username: "dev", displayName: "Developer Name" } };
const cleanResult = { findings: [], findingDecisions: [], effects: [
  { key: "summary", kind: "summary", body: "clean", findingIndexes: [] },
  { key: "label", kind: "label", label: "fred-review::clean", removeLabel: "fred-review::findings" },
] } satisfies ReviewResult;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-14T10:00:00Z"));
  vi.stubEnv("ADMIN_SECRET", admin.adminSecret);
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
async function next(t: Awaited<ReturnType<typeof setup>>) {
  const job = await t.mutation(api.jobs.claim, claim);
  if (job?.kind !== "review") throw new Error("expected job");
  return { job, lease: { ...auth, jobId: job._id, leaseToken: job.leaseToken } };
}
function usage(lease: Awaited<ReturnType<typeof next>>["lease"], provider: "fred" | "codex", model: string, costUsd: number, eventKey = "detect:1") {
  return { ...lease, eventKey, provider, model, stage: "detect" as const, inputTokens: 100, cachedInputTokens: 20, outputTokens: 5, costUsd, priceTableVersion: "test" };
}

it("keeps failures after a retry and records enqueue-time denials without a job", async () => {
  const t = await setup();
  await t.mutation(internal.enqueue.enqueue, { ...trigger, ...delivery() });
  const { job, lease } = await next(t);
  await t.mutation(api.jobs.recordUsage, usage(lease, "fred", "m", 1.25));
  await t.mutation(api.jobs.fail, { ...lease, failureReason: "timeout" });
  await t.mutation(internal.enqueue.enqueue, { ...trigger, deliveryKey: "d2" });
  expect(await t.run((ctx) => ctx.db.query("reviewJobs").collect())).toHaveLength(2);

  vi.stubEnv("FRED_MAINTENANCE_MODE", "true");
  expect(await t.mutation(internal.enqueue.enqueue, { ...trigger, mrIid: 2, deliveryKey: "d3" })).toMatchObject({ result: "denied" });

  const overview = await t.query(api.admin.overview, admin);
  expect(overview.queue).toMatchObject({ queued: 1, running: 0 });
  expect(overview.flags).toEqual({ globalEnabled: true, maintenanceMode: true });
  expect(overview.last7Days).toMatchObject({ failed: 1, denied: 0, deniedAtEnqueue: { maintenance: 1 } });

  const { rows, hasMore } = await t.query(api.admin.failures, admin);
  expect(hasMore).toBe(false);
  expect(rows).toMatchObject([
    { kind: "denied", reason: "maintenance", jobId: null, mrIid: 2, developer: { username: "dev", displayName: "Developer Name" }, costUsd: 0, detail: null },
    { kind: "failed", reason: "timeout", failureCategory: "timeout", jobId: job._id, project: { path: "group/a" }, costUsd: 1.25,
      detail: { headSha: "A", leaseGeneration: 1, phase: "context", failure: { category: "timeout" }, noteStatus: "pending" } },
  ]);
  expect(await t.query(api.admin.failures, { ...admin, kind: "failed" })).toMatchObject({ rows: [{ kind: "failed" }] });
});

it("lists jobs in flight with their phase, publication progress, and spend", async () => {
  const t = await setup();
  await t.mutation(internal.enqueue.enqueue, { ...trigger, ...delivery() });
  await t.mutation(internal.enqueue.enqueue, { ...trigger, mrIid: 2, deliveryKey: "d2" });
  await t.mutation(internal.enqueue.enqueue, { ...trigger, headSha: "B", deliveryKey: "d3" });
  const running = await next(t);
  await t.mutation(api.jobs.recordUsage, usage(running.lease, "fred", "m", 0.5));
  vi.advanceTimersByTime(1000);
  await t.mutation(api.diagnostics.record, { ...running.lease, eventsJson: "[]",
    snapshotJson: JSON.stringify({ phase: "detect", at: Date.now(), lastActivityAt: Date.now(), model: "m", droppedEvents: 0, leaseGeneration: 1 }) });
  const publishing = await next(t);
  await t.mutation(api.jobs.saveResult, { ...publishing.lease, resultJson: JSON.stringify(cleanResult) });
  await t.mutation(api.jobs.ackPublication, { ...publishing.lease, effectKey: "summary" });

  const { rows } = await t.query(api.admin.queue, admin);
  expect(rows).toMatchObject([
    { status: "queued", provider: "fred", mrIid: 1, headSha: "B", phase: "queue", claimedAt: null, workerId: null, project: { path: "group/a" }, developer: { username: "dev", displayName: "Developer Name" }, costUsd: 0 },
    { status: "running", provider: "fred", mrIid: 1, headSha: "A", phase: "detect", model: "m", workerId: "test", leaseGeneration: 1, costUsd: 0.5, findings: null, publication: { acknowledged: 0, total: null } },
    { status: "publishing", provider: "fred", mrIid: 2, phase: "publish", publication: { acknowledged: 1, total: 2 }, findings: { blocking: 0, should_fix: 0, nit: 0 } },
  ]);
});

it("orders a re-queued publication among queued jobs by creation time, not its old claim", async () => {
  const t = await setup();
  await t.mutation(internal.enqueue.enqueue, { ...trigger, ...delivery() });
  vi.advanceTimersByTime(1000);
  await t.mutation(internal.enqueue.enqueue, { ...trigger, mrIid: 2, deliveryKey: "d2" });
  vi.advanceTimersByTime(1000);
  const { job, lease } = await next(t);
  await t.mutation(api.jobs.saveResult, { ...lease, resultJson: JSON.stringify(cleanResult) });
  await t.mutation(api.jobs.fail, { ...lease, failureReason: "error" });
  await t.mutation(internal.enqueue.enqueue, { ...trigger, deliveryKey: "retry" });
  const { rows } = await t.query(api.admin.queue, admin);
  expect(rows.map((row) => [row.status, row.mrIid, row.jobId === job._id])).toEqual([["queued", 1, true], ["queued", 2, false]]);
});

it("records a comment that GitLab never accepted", async () => {
  const t = await setup();
  await t.mutation(internal.enqueue.enqueue, { ...trigger, ...delivery() });
  const { job, lease } = await next(t);
  await t.mutation(api.jobs.fail, { ...lease, failureReason: "error" });
  const note = await t.run((ctx) => ctx.db.query("mrNotes").first());
  if (!note) throw new Error("expected a failure note");
  await t.mutation(internal.mrNotes.recordAttempt, { noteId: note._id, attempt: 1, retryable: false, error: `HTTP 403 ${auth.workerSecret}` });
  const { rows } = await t.query(api.admin.failures, { ...admin, kind: "note_failed" });
  expect(rows).toMatchObject([{ kind: "note_failed", reason: "delivery", summary: "HTTP 403 [redacted]", jobId: job._id, triggeredBy: "42" }]);
});

it("keeps the original failure note details when delivery fails after publication recovery", async () => {
  const t = await setup();
  await t.mutation(internal.enqueue.enqueue, { ...trigger, ...delivery() });
  const { job, lease } = await next(t);
  await t.mutation(api.jobs.saveResult, { ...lease, resultJson: JSON.stringify(cleanResult) });
  await t.mutation(api.jobs.fail, { ...lease, failureReason: "error" });
  const note = await t.run((ctx) => ctx.db.query("mrNotes").first());
  if (!note) throw new Error("expected failure note");
  await t.mutation(internal.enqueue.enqueue, { ...trigger, deliveryKey: "retry-publication" });
  const recovered = await next(t);
  expect(recovered.job._id).toBe(job._id);
  expect(recovered.job.leaseGeneration).toBeGreaterThan(job.leaseGeneration ?? 0);
  await t.mutation(internal.mrNotes.recordAttempt, { noteId: note._id, attempt: 1, retryable: false, error: "HTTP 403" });
  const { rows } = await t.query(api.admin.failures, { ...admin, kind: "note_failed" });
  expect(rows).toMatchObject([{ jobId: job._id, detail: { leaseGeneration: 1, phase: "publish", noteStatus: "failed", workerId: null } }]);
});

it.each([false, true])("counts an expired job once with recorded usage %s in its org-local month", async (recorded) => {
  vi.setSystemTime(new Date("2026-08-31T22:30:00Z"));
  const t = await setup();
  await t.mutation(internal.enqueue.enqueue, { ...trigger, ...delivery() });
  const { lease } = await next(t);
  if (recorded) await t.mutation(api.jobs.recordUsage, usage(lease, "fred", "m", 1));
  vi.advanceTimersByTime(LEASE_MS + 1);
  await t.run(expireAnalysis);
  const { monthly } = await t.query(api.admin.spend, { ...admin, month: "2026-09" });
  expect(monthly.costUsd).toBe(recorded ? 1 : 0);
  expect(monthly.byDeveloper).toMatchObject([{ gitlabUserId: "42", costUsd: recorded ? 1 : 0, incompleteJobs: 1 }]);
  expect((await t.query(api.admin.spend, { ...admin, month: "2026-08" })).monthly.byDeveloper).toEqual([]);
});

it("counts a flagged job created in the previous month under the month its usage landed in, with a past month selected", async () => {
  vi.setSystemTime(new Date("2026-08-31T21:59:00Z"));
  const t = await setup();
  await t.mutation(internal.enqueue.enqueue, { ...trigger, ...delivery() });
  const { lease } = await next(t);
  vi.advanceTimersByTime(90_000);
  await t.mutation(api.jobs.recordUsage, usage(lease, "fred", "m", 1));
  vi.advanceTimersByTime(LEASE_MS + 1);
  await t.run(expireAnalysis);

  vi.setSystemTime(new Date("2026-10-20T10:00:00Z"));
  const september = await t.query(api.admin.spend, { ...admin, month: "2026-09" });
  expect(september.monthly).toMatchObject({ costUsd: 1, byDeveloper: [{ gitlabUserId: "42", costUsd: 1, reviews: 1, incompleteJobs: 1 }] });
  const august = await t.query(api.admin.spend, { ...admin, month: "2026-08" });
  expect(august.monthly).toMatchObject({ costUsd: 0, byDeveloper: [{ gitlabUserId: "42", costUsd: 0, reviews: 0, incompleteJobs: 1 }] });
});

it("derives the lab from the model ID and falls back to the bot identity for pre-OpenRouter rows", async () => {
  const t = await setup();
  await t.run(async (ctx) => {
    const amounts = { day: "2026-09-14", costMicroUsd: 1_000_000, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reviews: 0 };
    for (const [provider, model] of [["codex", "anthropic/claude-fable-5.1"], ["claude", "~x-ai/grok-5"], ["claude", "claude-opus-4-1"], ["codex", "gpt-5"]] as const) {
      await ctx.db.insert("usageDaily", { ...amounts, provider, model });
    }
  });
  const { monthly } = await t.query(api.admin.spend, admin);
  expect(Object.fromEntries(monthly.byModel.map(({ model, lab }) => [model, lab]))).toEqual({
    "anthropic/claude-fable-5.1": "anthropic", "x-ai/grok-5": "x-ai", "claude-opus-4-1": "anthropic", "gpt-5": "openai",
  });
});

it("folds the ~ alias spelling of a model into one model row", async () => {
  const t = await setup();
  await t.mutation(internal.enqueue.enqueue, { ...trigger, ...delivery() });
  const { lease } = await next(t);
  await t.mutation(api.jobs.recordUsage, usage(lease, "fred", "~x-ai/grok-5", 1));
  await t.mutation(api.jobs.recordUsage, usage(lease, "fred", "x-ai/grok-5", 2, "validate:1"));
  const { monthly } = await t.query(api.admin.spend, admin);
  expect(monthly.byModel).toMatchObject([{ lab: "x-ai", model: "x-ai/grok-5", costUsd: 3 }]);
});

it("aggregates spend by day, lab, model, and developer", async () => {
  const t = await setup();
  await t.mutation(internal.enqueue.enqueue, { ...trigger, ...delivery() });
  const a = await next(t);
  await t.mutation(api.jobs.recordUsage, usage(a.lease, "fred", "anthropic/claude-fable-5.1", 2));
  await t.mutation(api.jobs.recordUsage, usage(a.lease, "fred", "anthropic/claude-fable-5.1", 1, "validate:1"));
  await t.mutation(internal.enqueue.enqueue, { ...trigger, mrIid: 2, deliveryKey: "d2", budgetOwner: { gitlabUserId: "43" } });
  const b = await next(t);
  await t.mutation(api.jobs.recordUsage, usage(b.lease, "fred", "gpt-6-astra", 0.5));
  await t.run(async (ctx) => {
    const developer = await ctx.db.query("developers").withIndex("by_gitlab_user", (q) => q.eq("gitlabUserId", "43")).unique();
    if (developer) await ctx.db.insert("budgets", { developerId: developer._id, monthlyUsd: 50 });
  });

  const spend = await t.query(api.admin.spend, admin);
  expect(spend).toMatchObject({ today: "2026-09-14", month: "2026-09" });
  expect(spend.monthly.days).toHaveLength(14);
  expect(spend.monthly.daily[0]).toEqual({ day: "2026-09-01", byLab: { anthropic: 0, openai: 0 } });
  expect(spend.monthly.daily.at(-1)).toEqual({ day: "2026-09-14", byLab: { anthropic: 3, openai: 0.5 } });
  expect(spend.monthly.byLab).toMatchObject([
    { lab: "anthropic", costUsd: 3, reviews: 1, tokens: { inputTokens: 200, cachedInputTokens: 40, outputTokens: 10 } },
    { lab: "openai", costUsd: 0.5, reviews: 1, tokens: { inputTokens: 100, cachedInputTokens: 20, outputTokens: 5 } },
  ]);
  expect(spend.monthly).toMatchObject({ costUsd: 3.5, workingDays: { elapsed: 10, total: 22 }, projectedUsd: (3.5 / 10) * 22 });
  expect(spend.monthly.byModel).toMatchObject([{ lab: "anthropic", model: "anthropic/claude-fable-5.1", costUsd: 3 }, { lab: "openai", model: "gpt-6-astra", costUsd: 0.5 }]);
  expect(spend.monthly.byDeveloper).toMatchObject([
    { username: "dev", displayName: "Developer Name", gitlabUserId: "42", costUsd: 3, budgetUsd: 3000, budgetOverride: false, reviews: 1, blocked: false },
    { username: null, displayName: null, gitlabUserId: "43", costUsd: 0.5, budgetUsd: 50, budgetOverride: true, reviews: 1 },
  ]);
  const august = await t.query(api.admin.spend, { ...admin, month: "2026-08" });
  expect(august).toMatchObject({ monthly: { costUsd: 0, byLab: [], byModel: [], byDeveloper: [], workingDays: { elapsed: 21, total: 21 }, perWorkingDayUsd: 0 } });
  expect(august.monthly.days).toHaveLength(31);
  expect(august.monthly.daily.at(-1)).toEqual({ day: "2026-08-31", byLab: {} });
});

it("counts completed reviews, clean labels, and latency for the month", async () => {
  const t = await setup();
  await t.mutation(internal.enqueue.enqueue, { ...trigger, ...delivery() });
  vi.advanceTimersByTime(30_000);
  const { lease } = await next(t);
  vi.advanceTimersByTime(60_000);
  await t.mutation(api.jobs.saveResult, { ...lease, resultJson: JSON.stringify(cleanResult) });
  await t.mutation(api.jobs.ackPublication, { ...lease, effectKey: "summary" });
  await t.mutation(api.jobs.ackPublication, { ...lease, effectKey: "label" });
  await t.mutation(api.jobs.complete, lease);
  const { outcomes } = await t.query(api.admin.overview, admin);
  expect(outcomes).toMatchObject([
    { provider: "fred", done: 1, clean: 1, findingsTotal: 0, latency: { claimP50Ms: 30_000, runP50Ms: 60_000, runMaxMs: 60_000 } },
    { provider: "claude", done: 0, clean: 0, latency: { claimP50Ms: null } },
    { provider: "codex", done: 0, clean: 0, latency: { claimP50Ms: null } },
  ]);
});

it("backfills the outcome of a review completed before outcome rows existed, once", async () => {
  const t = await setup();
  await t.mutation(internal.enqueue.enqueue, { ...trigger, ...delivery() });
  const { lease } = await next(t);
  await t.mutation(api.jobs.saveResult, { ...lease, resultJson: JSON.stringify(cleanResult) });
  await t.mutation(api.jobs.ackPublication, { ...lease, effectKey: "summary" });
  await t.mutation(api.jobs.ackPublication, { ...lease, effectKey: "label" });
  await t.mutation(api.jobs.complete, lease);
  await t.run(async (ctx) => { for (const row of await ctx.db.query("reviewOutcomes").collect()) await ctx.db.delete(row._id); });

  expect(await t.mutation(internal.migrations.backfillReviewOutcomes, {})).toMatchObject({ inserted: 1, remaining: false });
  expect(await t.mutation(internal.migrations.backfillReviewOutcomes, {})).toMatchObject({ inserted: 0, remaining: false });
  const { outcomes } = await t.query(api.admin.overview, admin);
  expect(outcomes[0]).toMatchObject({ provider: "fred", done: 1, clean: 1 });
});

it.each([undefined, "denied"] as const)("pages same-timestamp failures without gaps with kind %s", async (kind) => {
  const t = await setup();
  vi.stubEnv("FRED_MAINTENANCE_MODE", "true");
  for (let mrIid = 1; mrIid <= 3; mrIid++) {
    await t.mutation(internal.enqueue.enqueue, { ...trigger, mrIid, deliveryKey: `denied:${mrIid}` });
  }
  const args = { ...admin, ...(kind === undefined ? {} : { kind }), limit: 2 };
  const first = await t.query(api.admin.failures, args);
  expect(first.rows).toHaveLength(2);
  expect(first.hasMore).toBe(true);
  if (!first.nextCursor) throw new Error("expected cursor");
  const second = await t.query(api.admin.failures, { ...args, cursor: first.nextCursor });
  expect(second.rows).toHaveLength(1);
  expect(second.hasMore).toBe(false);
  expect(second.nextCursor).toBeNull();
  const rows = [...first.rows, ...second.rows];
  expect(new Set(rows.map((row) => row.at)).size).toBe(1);
  expect(rows.map((row) => row.mrIid).sort()).toEqual([1, 2, 3]);
});

it.each(["2026-00", "2026-13"])("rejects invalid calendar month %s", async (month) => {
  const t = await setup();
  await expect(t.query(api.admin.spend, { ...admin, month })).rejects.toThrow("month must be yyyy-mm");
});

const findingsResult = { findings: [{ file: "src/a.ts", line: 3, severity: "blocking", title: "bug", body: "evidence", status: "pending" }], findingDecisions: [], effects: [
  { key: "summary", kind: "summary", body: "one finding", findingIndexes: [0] },
  { key: "finding:0", kind: "finding", findingIndex: 0, body: "evidence" },
  { key: "label", kind: "label", label: "fred-review::findings", removeLabel: "fred-review::clean" },
] } satisfies ReviewResult;

// One accepted blocking finding plus a validator reject and a duplicate, which never count by severity.
const dropped = { file: "src/b.ts", severity: "should_fix", title: "dropped", body: "evidence", rejectReason: "not confirmed" } as const;
const mixedResult = { ...findingsResult, findings: [...findingsResult.findings, { ...dropped, status: "rejected" }, { ...dropped, status: "duplicate" }] } satisfies ReviewResult;

// Saves mixedResult for a claimed job, acknowledges its effects, and completes it.
async function completeMixed(t: Awaited<ReturnType<typeof setup>>, lease: Awaited<ReturnType<typeof next>>["lease"]) {
  await t.mutation(api.jobs.saveResult, { ...lease, resultJson: JSON.stringify(mixedResult) });
  await t.mutation(api.jobs.ackPublication, { ...lease, effectKey: "summary" });
  await t.mutation(api.jobs.ackPublication, { ...lease, effectKey: "finding:0", discussionId: "d1" });
  await t.mutation(api.jobs.ackPublication, { ...lease, effectKey: "label" });
  await t.mutation(api.jobs.complete, lease);
}

it("recounts outcome rows that counted duplicate findings by severity, once", async () => {
  const t = await setup();
  await t.mutation(internal.enqueue.enqueue, { ...trigger, ...delivery() });
  await completeMixed(t, (await next(t)).lease);
  const legacy = { findings: { blocking: 1, should_fix: 1, nit: 0 }, validatorRejected: 1 };
  await t.run(async (ctx) => ctx.db.patch((await ctx.db.query("reviewOutcomes").unique())!._id, legacy));

  expect(await t.mutation(internal.migrations.recountOutcomeFindings, {})).toMatchObject({ patched: 1, remaining: false });
  expect(await t.mutation(internal.migrations.recountOutcomeFindings, {})).toMatchObject({ patched: 0, remaining: false });
  const { outcomes } = await t.query(api.admin.overview, admin);
  expect(outcomes[0]).toMatchObject({ provider: "fred", done: 1, findings: { blocking: 1, should_fix: 0, nit: 0 }, validatorRejected: 1, findingsTotal: 2 });
});

it("lists finished reviews newest first and filters them by status, provider, and model", async () => {
  const t = await setup();
  const fable = { model: "anthropic/claude-fable-5.1", effort: "high" };
  await t.run(async (ctx) => ctx.db.patch((await ctx.db.query("projects").unique())!._id, { stageModels: { detect: fable, validate: fable } }));
  await t.mutation(internal.enqueue.enqueue, { ...trigger, ...delivery() });
  const done = await next(t);
  await t.mutation(api.jobs.recordUsage, usage(done.lease, "fred", "~anthropic/claude-fable-5.1", 2));
  await t.mutation(api.jobs.saveResult, { ...done.lease, resultJson: JSON.stringify(cleanResult) });
  await t.mutation(api.jobs.ackPublication, { ...done.lease, effectKey: "summary" });
  await t.mutation(api.jobs.ackPublication, { ...done.lease, effectKey: "label" });
  await t.mutation(api.jobs.complete, done.lease);
  vi.advanceTimersByTime(1000);
  await t.run(async (ctx) => {
    const projectId = (await ctx.db.query("projects").unique())!._id;
    const developerId = (await ctx.db.query("developers").unique())!._id;
    const jobId = await ctx.db.insert("reviewJobs", { projectId, developerId, mrIid: 2, headSha: "A", provider: "codex", status: "failed",
      failureReason: "timeout", stageModels: { detect: fable, validate: fable }, triggeredBy: "42", completedAt: Date.now() });
    await ctx.db.insert("usageEvents", { jobId, developerId, month: "2026-09", day: "2026-09-14", provider: "codex", model: "openai/gpt-6-astra",
      stage: "detect", inputTokens: 100, cachedInputTokens: 20, outputTokens: 5, costUsd: 0.5, priceTableVersion: "test" });
  });
  vi.advanceTimersByTime(1000);
  await t.mutation(internal.enqueue.enqueue, { ...trigger, mrIid: 3, deliveryKey: "d3" });
  vi.stubEnv("FRED_MAINTENANCE_MODE", "true");
  await t.mutation(api.jobs.claim, claim);
  vi.stubEnv("FRED_MAINTENANCE_MODE", undefined);
  vi.advanceTimersByTime(1000);
  await t.mutation(internal.enqueue.enqueue, { ...trigger, mrIid: 4, deliveryKey: "d4" });
  await t.mutation(internal.enqueue.enqueue, { ...trigger, mrIid: 4, deliveryKey: "d5", kind: "push", headSha: "B" });

  const all = await t.query(api.admin.reviews, admin);
  expect(all.hasMore).toBe(false);
  expect(all.models).toEqual(["anthropic/claude-fable-5.1", "openai/gpt-6-astra"]);
  expect(all.rows).toMatchObject([
    { status: "superseded", provider: "fred", mrIid: 4, headSha: "A", claimedAt: null, costUsd: 0 },
    { status: "denied", provider: "fred", mrIid: 3, verdict: null, claimedAt: null, costUsd: 0, models: ["anthropic/claude-fable-5.1"] },
    { status: "failed", provider: "codex", mrIid: 2, failureReason: "timeout", costUsd: 0.5, models: ["anthropic/claude-fable-5.1", "openai/gpt-6-astra"], project: { path: "group/a" } },
    { status: "done", provider: "fred", mrIid: 1, verdict: "clean", costUsd: 2, findings: { blocking: 0, should_fix: 0, nit: 0, rejected: 0, duplicate: 0 },
      developer: { displayName: "Developer Name" } },
  ]);
  const mrs = async (filter: Partial<Parameters<typeof t.query<typeof api.admin.reviews>>[1]>) => (await t.query(api.admin.reviews, { ...admin, ...filter })).rows.map((row) => row.mrIid);
  expect(await mrs({ statuses: ["done"] })).toEqual([1]);
  expect(await mrs({ statuses: ["superseded"] })).toEqual([4]);
  expect(await mrs({ statuses: ["failed", "denied"] })).toEqual([3, 2]);
  expect(await mrs({ provider: "codex" })).toEqual([2]);
  expect(await mrs({ models: ["openai/gpt-6-astra"] })).toEqual([2]);
});

it("names the FRED version whose worker produced a finished review", async () => {
  const t = await setup();
  await t.mutation(internal.enqueue.enqueue, { ...trigger, ...delivery() });
  const { lease } = await next(t);
  await t.mutation(api.jobs.saveResult, { ...lease, resultJson: JSON.stringify(cleanResult), fredVersion: "0.3.1" });
  await t.mutation(api.jobs.ackPublication, { ...lease, effectKey: "summary" });
  await t.mutation(api.jobs.ackPublication, { ...lease, effectKey: "label" });
  await t.mutation(api.jobs.complete, lease);
  const { rows } = await t.query(api.admin.reviews, admin);
  expect(rows).toMatchObject([{ status: "done", fredVersion: "0.3.1" }]);
});

it("pages finished reviews by limit and window", async () => {
  const t = await setup();
  for (const mrIid of [1, 2, 3]) {
    await t.mutation(internal.enqueue.enqueue, { ...trigger, mrIid, deliveryKey: `d${mrIid}` });
    const { lease } = await next(t);
    await t.mutation(api.jobs.fail, { ...lease, failureReason: "error" });
    vi.advanceTimersByTime(60_000);
  }
  const page = await t.query(api.admin.reviews, { ...admin, limit: 2 });
  expect(page.rows.map((row) => row.mrIid)).toEqual([3, 2]);
  expect(page.hasMore).toBe(true);
  const recent = await t.query(api.admin.reviews, { ...admin, since: Date.now() - 90_000 });
  expect(recent.rows.map((row) => row.mrIid)).toEqual([3]);
  expect(recent.hasMore).toBe(false);
});

it("totals finished reviews over the whole window, independent of the table's limit", async () => {
  const t = await setup();
  await t.mutation(internal.enqueue.enqueue, { ...trigger, ...delivery() });
  vi.advanceTimersByTime(30_000);
  const done = await next(t);
  await t.mutation(api.jobs.recordUsage, usage(done.lease, "fred", "m", 2));
  vi.advanceTimersByTime(60_000);
  await completeMixed(t, done.lease);
  for (const mrIid of [2, 3]) {
    vi.advanceTimersByTime(60_000);
    await t.mutation(internal.enqueue.enqueue, { ...trigger, mrIid, deliveryKey: `d${mrIid}` });
    const { lease } = await next(t);
    await t.mutation(api.jobs.recordUsage, usage(lease, "fred", "m", 0.5));
    await t.mutation(api.jobs.fail, { ...lease, failureReason: "error" });
  }
  vi.advanceTimersByTime(60_000);
  await t.mutation(internal.enqueue.enqueue, { ...trigger, mrIid: 4, deliveryKey: "d4" });
  vi.stubEnv("FRED_MAINTENANCE_MODE", "true");
  await t.mutation(api.jobs.claim, claim);

  expect((await t.query(api.admin.reviews, { ...admin, limit: 1 })).rows).toHaveLength(1);
  expect(await t.query(api.admin.reviewStats, admin)).toEqual({ reviews: 4, done: 1, failed: 2, clean: 0, findings: 1, runP50Ms: 60_000, costUsd: 3 });
  expect(await t.query(api.admin.reviewStats, { ...admin, statuses: ["failed", "denied"] })).toMatchObject({ reviews: 3, done: 0, failed: 2, costUsd: 1 });
  expect(await t.query(api.admin.reviewStats, { ...admin, since: Date.now() - 90_000 })).toMatchObject({ reviews: 2, done: 0, failed: 1 });
  expect(await t.query(api.admin.reviewStats, { ...admin, provider: "codex" })).toMatchObject({ reviews: 0, runP50Ms: null, costUsd: 0 });
});

it("returns one review in full with its summary, findings, and ledger rows", async () => {
  const t = await setup();
  await t.mutation(internal.enqueue.enqueue, { ...trigger, ...delivery() });
  const { job, lease } = await next(t);
  await t.mutation(api.jobs.recordUsage, usage(lease, "fred", "~anthropic/claude-fable-5.1", 1));
  await t.mutation(api.jobs.saveResult, { ...lease, resultJson: JSON.stringify(findingsResult) });
  expect(await t.query(api.admin.review, { ...admin, jobId: job._id })).toMatchObject({
    summary: "one finding", phase: "publish",
    findings: [{ severity: "blocking", status: "pending", file: "src/a.ts", line: 3, oldLine: null, title: "bug", rejectReason: null }],
    usage: [{ stage: "detect", model: "anthropic/claude-fable-5.1", costUsd: 1, incomplete: false }],
    publication: { acknowledged: 0, total: 3 },
  });
});
