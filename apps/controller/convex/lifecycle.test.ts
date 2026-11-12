import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { connectProject, delivery, modules, testTokenKey } from "./test.setup";

const auth = { workerSecret: "worker-test" };
const claim = { ...auth, workerId: "test" };
const trigger = { provider: "fred" as const, kind: "push" as const, headSha: "A", mrIid: 1,
  project: { gitlabProjectId: "7", path: "group/a" }, triggeredBy: "42", budgetOwner: { gitlabUserId: "42" } };
const emptyResult = JSON.stringify({ findings: [], resolvedFindingIds: [], effects: [{ kind: "summary", key: "summary", body: "clean", findingIndexes: [] }] });

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("WORKER_SECRET", auth.workerSecret);
  vi.stubEnv("FRED_TOKEN_KEY", testTokenKey);
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

it("duplicate and older push replays preserve newest queued review", async () => {
  const t = await setup();
  const event = trigger;
  await t.mutation(internal.enqueue.enqueue, { ...event, ...delivery() });
  await t.mutation(internal.enqueue.enqueue, { ...event, ...delivery() });
  expect(await t.query(api.jobs.listQueued, auth)).toHaveLength(1);
  await t.mutation(internal.enqueue.enqueue, { ...delivery(), ...event, headSha: "B" });
  await t.mutation(internal.enqueue.enqueue, { ...event, ...delivery() });
  expect((await next(t)).job.headSha).toBe("B");
});

it("claim refreshes baseline after the previous review completes", async () => {
  const t = await setup();
  await t.mutation(internal.enqueue.enqueue, { ...trigger, ...delivery() });
  const a = await next(t);
  await t.mutation(internal.enqueue.enqueue, { ...delivery(), ...trigger, headSha: "B" });
  await t.mutation(api.jobs.saveResult, { ...a.lease, resultJson: emptyResult });
  await t.mutation(api.jobs.ackPublication, { ...a.lease, effectKey: "summary" });
  await t.mutation(api.jobs.complete, a.lease);
  expect((await next(t)).job.previousReviewedSha).toBe("A");
});

it("validates previous finding ownership before storing any new result", async () => {
  const t = await setup();
  await t.mutation(internal.enqueue.enqueue, { ...trigger, ...delivery() });
  const { job, lease } = await next(t);
  const ids = await t.run(async (ctx) => {
    const otherProject = await ctx.db.insert("projects", { gitlabProjectId: "8", path: "other/b" });
    const base = { file: "a.ts", line: 1, severity: "blocking" as const, title: "bug", body: "details", status: "posted" as const,
      jobId: job._id, projectId: job.projectId, mrIid: 1, provider: "fred" as const };
    const oldJob = await ctx.db.insert("reviewJobs", { projectId: job.projectId, developerId: job.developerId,
      mrIid: 1, provider: "fred", headSha: "old", status: "done", triggeredBy: "42" });
    return Promise.all([
      ctx.db.insert("findings", { ...base, jobId: oldJob, projectId: otherProject }),
      ctx.db.insert("findings", { ...base, jobId: oldJob, mrIid: 2 }),
      ctx.db.insert("findings", { ...base, jobId: oldJob, provider: "claude" }),
      ctx.db.insert("findings", { ...base, jobId: oldJob, status: "rejected" }),
      ctx.db.insert("findings", base),
    ]);
  });
  for (const id of ids) {
    await expect(t.mutation(api.jobs.saveResult, { ...lease,
      resultJson: JSON.stringify({ findings: [], resolvedFindingIds: [id], effects: [{ kind: "summary", key: "summary", body: "clean", findingIndexes: [] }] }),
    })).rejects.toThrow(/earlier review/);
  }
  expect(await t.run((ctx) => ctx.db.get(job._id))).toMatchObject({ status: "running" });
  expect(await t.run((ctx) => ctx.db.query("findings").collect())).toHaveLength(ids.length);
});

it("resolves summary-only findings by finding ID without an invented discussion", async () => {
  const t = await setup();
  await t.mutation(internal.enqueue.enqueue, { ...trigger, ...delivery() });
  const a = await next(t);
  await t.mutation(api.jobs.saveResult, { ...a.lease, resultJson: JSON.stringify({ findings: [
    { file: "a.ts", severity: "nit", title: "nit", body: "details", status: "pending" },
  ], resolvedFindingIds: [], effects: [{ kind: "summary", key: "summary", body: "nit", findingIndexes: [0] }] }) });
  await t.mutation(api.jobs.ackPublication, { ...a.lease, effectKey: "summary" });
  await t.mutation(api.jobs.complete, a.lease);
  await t.mutation(internal.enqueue.enqueue, { ...delivery(), ...trigger, headSha: "B" });
  const b = await next(t);
  const previous = await t.query(api.jobs.previousFindings, { ...auth, jobId: b.job._id });
  await t.mutation(api.jobs.saveResult, { ...b.lease,
    resultJson: JSON.stringify({ findings: [], resolvedFindingIds: [previous[0]!._id], effects: [{ kind: "summary", key: "summary", body: "clean", findingIndexes: [] }] }) });
  expect(previous[0]?.discussionId).toBeUndefined();
  await t.mutation(api.jobs.ackPublication, { ...b.lease, effectKey: "summary" });
  await t.mutation(api.jobs.complete, b.lease);
  expect(await t.run((ctx) => ctx.db.get(previous[0]!._id))).toMatchObject({ status: "posted", disposition: "fixed" });
});

it("refreshes project path even when an event is a replay", async () => {
  const t = await setup();
  await t.mutation(internal.enqueue.enqueue, { ...trigger, ...delivery() });
  await t.mutation(internal.enqueue.enqueue, { ...delivery(), ...trigger, project: { ...trigger.project, path: "renamed/a" } });
  expect((await next(t)).job.projectPath).toBe("renamed/a");
});
