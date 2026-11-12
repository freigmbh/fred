import { decisionPublication } from "@fred/contracts";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { unconnectedProject } from "./projectTokens";
import schema from "./schema";
import { connectProject, delivery, modules, testTokenKey } from "./test.setup";

const auth = { workerSecret: "worker-test" };
const claim = { ...auth, workerId: "worker" };
const trigger = { provider: "fred" as const, headSha: "B", mrIid: 1, project: { gitlabProjectId: "7", path: "group/repo" }, triggeredBy: "42", budgetOwner: { gitlabUserId: "42" } };

beforeEach(() => {
  vi.stubEnv("WORKER_SECRET", auth.workerSecret);
  vi.stubEnv("FRED_TOKEN_KEY", testTokenKey);
  vi.stubEnv("GITLAB_URL", "https://gitlab.example");
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

// A done FRED review on MR 1 with an open should-fix finding, a nit, and a finding of the retired Claude bot on the same MR.
async function setup() {
  const t = convexTest(schema, modules);
  const projectId = await connectProject(t, trigger.project);
  const fixture = await t.run(async (ctx) => {
    await ctx.db.insert("settings", { globalEnabled: true, defaultBudgetUsd: 100, orgTimezone: "Europe/Berlin" });
    const developerId = await ctx.db.insert("developers", { gitlabUserId: "42" });
    const jobId = await ctx.db.insert("reviewJobs", { projectId, developerId, provider: "fred", mrIid: 1, headSha: "A", status: "done", triggeredBy: "42", summaryNoteId: "10" });
    const finding = { projectId, jobId, provider: "fred" as const, mrIid: 1, status: "posted" as const, disposition: "open" as const,
      file: "file.ts", title: "Concern", body: "Evidence", severity: "should_fix" as const, resultIndex: 0 };
    const findingId = await ctx.db.insert("findings", finding);
    const nit = await ctx.db.insert("findings", { ...finding, severity: "nit", resultIndex: 1 });
    const other = await ctx.db.insert("findings", { ...finding, provider: "claude", resultIndex: 2 });
    return { projectId, developerId, jobId, findingId, nit, other };
  });
  const enqueue = (noteId: string, action: "dismiss" | "undo", reference: string) => t.mutation(internal.findingCommands.enqueue, {
    gitlabProjectId: "7", mrIid: 1, actorId: "42", noteId, action, reference, reason: "The requirement changed.",
  });
  const next = async () => {
    const command = await t.mutation(api.jobs.claim, claim);
    if (!command || command.kind !== "finding_command") throw new Error("expected finding command");
    return { command, lease: { ...auth, commandId: command._id, leaseToken: command.leaseToken } };
  };
  const finish = async (lease: Awaited<ReturnType<typeof next>>["lease"]) => {
    await t.mutation(api.findingCommands.acknowledge, { ...lease, effect: "decision" });
    await t.mutation(api.findingCommands.acknowledge, { ...lease, effect: "label" });
  };
  return { t, ...fixture, enqueue, next, finish };
}

it("dismissal and undo retain history and isolate providers", async () => {
  const f = await setup();
  await f.enqueue("11", "dismiss", `${f.jobId}/0`);
  expect(await f.enqueue("11", "dismiss", `${f.jobId}/0`)).toEqual({ duplicate: true });
  const dismissed = await f.next();
  const result = await f.t.mutation(api.findingCommands.prepare, dismissed.lease);
  expect(decisionPublication.parse(JSON.parse(result!))).toMatchObject({ label: "clean", resolved: true });
  expect(result).not.toContain("Fixed in");
  expect(await f.t.mutation(api.findingCommands.prepare, dismissed.lease)).toBe(result);
  await f.finish(dismissed.lease);
  await f.t.mutation(api.findingCommands.acknowledge, { ...dismissed.lease, effect: "label" });
  const finding = await f.t.run((ctx) => ctx.db.get(f.findingId));
  expect(finding).toMatchObject({ status: "posted", disposition: "dismissed", body: "Evidence" });
  expect(await f.t.run((ctx) => ctx.db.get(f.other))).toMatchObject({ disposition: "open" });
  expect(await f.t.run((ctx) => ctx.db.query("findingDecisions").collect())).toHaveLength(1);
  await f.enqueue("12", "undo", `command:${dismissed.command._id}`);
  const undo = await f.next();
  expect(decisionPublication.parse(JSON.parse((await f.t.mutation(api.findingCommands.prepare, undo.lease))!))).toMatchObject({ label: "findings", resolved: false });
  await f.finish(undo.lease);
  expect(await f.t.run((ctx) => ctx.db.get(f.findingId))).toMatchObject({ disposition: "open" });
  expect(await f.t.run((ctx) => ctx.db.query("findingDecisions").collect())).toMatchObject([
    { before: "open", after: "dismissed", source: "human", actorId: "42", noteId: "11" },
    { before: "dismissed", after: "open", supersedes: finding!.decisionId },
  ]);
  await f.enqueue("13", "undo", `command:${dismissed.command._id}`);
  const stale = await f.next();
  expect(await f.t.mutation(api.findingCommands.prepare, stale.lease)).toBeNull();
  expect(await f.t.run((ctx) => ctx.db.query("findingDecisions").collect())).toHaveLength(2);
});

it("rejects a command for a retired bot's finding with one reply", async () => {
  const f = await setup();
  expect(await f.enqueue("11", "dismiss", f.other)).toEqual({ rejected: true });
  expect(await f.t.run((ctx) => ctx.db.query("findingCommands").collect())).toEqual([]);
  expect(await f.t.run((ctx) => ctx.db.query("mrNotes").collect())).toMatchObject([{ provider: "fred",
    body: "Finding command rejected: That finding belongs to a retired reviewer account. FRED can only change its own findings." }]);
  expect(await f.t.run((ctx) => ctx.db.get(f.other))).toMatchObject({ disposition: "open" });
});

it("fails a queued command at claim when the project has no usable token", async () => {
  const f = await setup();
  await f.enqueue("11", "dismiss", `${f.jobId}/0`);
  await f.t.run(async (ctx) => ctx.db.delete((await ctx.db.query("projectTokens").unique())!._id));
  expect(await f.t.mutation(api.jobs.claim, claim)).toBeNull();
  expect(await f.t.run((ctx) => ctx.db.query("findingCommands").collect())).toMatchObject([{ status: "failed", failure: unconnectedProject }]);
  expect(await f.t.run((ctx) => ctx.db.query("mrNotes").collect())).toMatchObject([{ body: `Finding command publication failed: ${unconnectedProject}. No decision was applied.` }]);
  expect(await f.t.run((ctx) => ctx.db.get(f.findingId))).toMatchObject({ disposition: "open" });
});

it("remaining actionable findings preserve findings label and link to their summary", async () => {
  const f = await setup();
  await f.t.run(async (ctx) => {
    const original = (await ctx.db.get(f.findingId))!;
    const { _id, _creationTime, ...fields } = original;
    await ctx.db.insert("findings", { ...fields, resultIndex: 3, severity: "blocking" });
  });
  await f.enqueue("11", "dismiss", `${f.jobId}/0`);
  const command = await f.next();
  const result = decisionPublication.parse(JSON.parse((await f.t.mutation(api.findingCommands.prepare, command.lease))!));
  expect(result.label).toBe("findings");
  expect(result.body).toContain("1 actionable findings remain");
  expect(result.body).toContain("#note_10");
});

it("a human decision waits for active review ownership and does not advance the review baseline", async () => {
  const f = await setup();
  await f.t.mutation(internal.enqueue.enqueue, { ...delivery(), ...trigger, kind: "push" });
  const review = await f.t.mutation(api.jobs.claim, claim);
  if (!review || review.kind !== "review") throw new Error("expected review");
  await f.enqueue("11", "dismiss", `${f.jobId}/0`);
  expect(await f.t.mutation(api.jobs.claim, { ...claim, workerId: "another" })).toBeNull();
  await f.t.mutation(api.jobs.supersede, { ...auth, jobId: review._id, leaseToken: review.leaseToken });
  const command = await f.next();
  await f.t.mutation(api.findingCommands.prepare, command.lease);
  await f.finish(command.lease);
  expect(await f.t.run((ctx) => ctx.db.query("usageEvents").collect())).toHaveLength(0);
  expect((await f.t.run((ctx) => ctx.db.query("reviewJobs").collect())).filter((job) => job.status === "done")).toHaveLength(1);
});

it("saved review publication is fenced after a later dismissal, while late summary acknowledgements preserve disposition", async () => {
  const f = await setup();
  await f.t.mutation(internal.enqueue.enqueue, { ...delivery(), ...trigger, kind: "push" });
  const review = await f.t.mutation(api.jobs.claim, claim);
  if (!review || review.kind !== "review") throw new Error("expected review");
  const lease = { ...auth, jobId: review._id, leaseToken: review.leaseToken };
  await f.t.mutation(api.jobs.saveResult, { ...lease, resultJson: JSON.stringify({ findings: [], findingDecisions: [], effects: [
    { kind: "summary", key: "summary", body: "Earlier findings remain", findingIndexes: [] },
    { kind: "label", key: "label", label: "fred-review::findings", removeLabel: "fred-review::clean" },
  ] }) });
  await f.t.mutation(api.jobs.fail, { ...lease, failureReason: "error" });
  await f.enqueue("11", "dismiss", `${f.jobId}/0`);
  const command = await f.next();
  await f.t.mutation(api.findingCommands.prepare, command.lease);
  await f.finish(command.lease);
  await f.t.mutation(internal.enqueue.enqueue, { ...trigger, kind: "reviewer_added", deliveryKey: "retry" });
  const recovered = await f.t.mutation(api.jobs.claim, claim);
  if (!recovered || recovered.kind !== "review") throw new Error("expected recovered review");
  const recoveredLease = { ...auth, jobId: recovered._id, leaseToken: recovered.leaseToken };
  expect(await f.t.mutation(api.jobs.heartbeat, recoveredLease)).toMatchObject({ publicationCurrent: false });
  await f.t.mutation(api.jobs.ackPublication, { ...recoveredLease, effectKey: "summary", noteId: "99" });
  await expect(f.t.mutation(api.jobs.ackPublication, { ...recoveredLease, effectKey: "label" })).rejects.toThrow("publication finding revision is outdated");
  await f.t.mutation(api.jobs.supersede, recoveredLease);
  expect(await f.t.run((ctx) => ctx.db.get(f.findingId))).toMatchObject({ disposition: "dismissed" });
});

it.each(["fixed", "retracted"] as const)("validator %s decisions retain evidence, isolate providers, and enforce undo eligibility", async (disposition) => {
  const f = await setup();
  await f.t.mutation(internal.enqueue.enqueue, { ...delivery(), ...trigger, kind: "push" });
  const job = await f.t.mutation(api.jobs.claim, claim);
  if (!job || job.kind !== "review") throw new Error("expected review");
  const lease = { ...auth, jobId: job._id, leaseToken: job.leaseToken };
  const result = (findingId: string) => JSON.stringify({ findings: [], findingDecisions: [{ findingId, disposition, reason: "Evidence from the current checkout.", expectedDecisionId: null }],
    effects: [{ kind: "summary", key: "summary", body: "Retracted earlier finding", findingIndexes: [] }] });
  await expect(f.t.mutation(api.jobs.saveResult, { ...lease, resultJson: result(f.other) })).rejects.toThrow(/provider/);
  await f.t.mutation(api.jobs.saveResult, { ...lease, resultJson: result(f.findingId) });
  await f.t.mutation(api.jobs.ackPublication, { ...lease, effectKey: "summary" });
  await f.t.mutation(api.jobs.complete, lease);
  await f.t.mutation(api.jobs.complete, lease);
  expect(await f.t.run((ctx) => ctx.db.get(f.findingId))).toMatchObject({ status: "posted", disposition });
  expect(await f.t.run((ctx) => ctx.db.query("findingDecisions").collect())).toMatchObject([{ source: "validator", after: disposition, headSha: "B" }]);
  const undo = await f.enqueue("20", "undo", `${job._id}:decision:${f.findingId}`);
  if (disposition === "fixed") {
    expect(undo).toEqual({ rejected: true });
    expect(await f.t.run((ctx) => ctx.db.query("mrNotes").collect())).toMatchObject([{ body: "Finding command rejected: Only a dismissal or retraction can be undone." }]);
  } else {
    const command = await f.next();
    await f.t.mutation(api.findingCommands.prepare, command.lease);
    expect(await f.t.run((ctx) => ctx.db.get(f.findingId))).toMatchObject({ disposition: "open" });
  }
});

it.each([false, true])("failure reporting reflects whether a decision was saved: %s", async (prepared) => {
  const f = await setup();
  await f.enqueue("11", "dismiss", `${f.jobId}/0`);
  const command = await f.next();
  if (prepared) await f.t.mutation(api.findingCommands.prepare, command.lease);
  await f.t.mutation(api.findingCommands.fail, { ...command.lease, message: "Publication stopped (GitLabError)" });
  expect(await f.t.run((ctx) => ctx.db.query("mrNotes").collect())).toMatchObject([{
    body: `Finding command publication failed: Publication stopped (GitLabError). ${prepared ? "The decision is retained." : "No decision was applied."}`,
  }]);
  expect(await f.t.run((ctx) => ctx.db.get(f.findingId))).toMatchObject({ disposition: prepared ? "dismissed" : "open" });
});

it("posts one comment for each failed publication attempt of a command", async () => {
  vi.useFakeTimers();
  const f = await setup();
  await f.enqueue("11", "dismiss", `${f.jobId}/0`);
  for (const attempt of [1, 2]) {
    const command = await f.next();
    if (attempt === 1) await f.t.mutation(api.findingCommands.prepare, command.lease);
    await f.t.mutation(api.findingCommands.fail, { ...command.lease, message: `Attempt ${attempt} stopped` });
    vi.advanceTimersByTime(30_001);
  }
  expect((await f.t.run((ctx) => ctx.db.query("mrNotes").collect())).map((note) => note.body)).toEqual([
    "Finding command publication failed: Attempt 1 stopped. The decision is retained.",
    "Finding command publication failed: Attempt 2 stopped. The decision is retained.",
  ]);
});

it("migration preserves legacy findings and saved result bytes with explicit missing provenance", async () => {
  const f = await setup();
  const oldJson = JSON.stringify({ findings: [], resolvedFindingIds: [], effects: [{ kind: "summary", key: "summary", body: "legacy", findingIndexes: [] }] });
  await f.t.run(async (ctx) => {
    await ctx.db.patch(f.findingId, { status: "resolved", disposition: undefined });
    await ctx.db.patch(f.jobId, { resultJson: oldJson });
  });
  expect(await f.t.mutation(internal.migrations.backfillFindingDisposition, {})).toMatchObject({ patched: 1 });
  expect(await f.t.mutation(internal.migrations.backfillFindingDisposition, {})).toMatchObject({ patched: 0 });
  expect(await f.t.run((ctx) => ctx.db.get(f.findingId))).toMatchObject({ status: "posted", disposition: "fixed" });
  expect(await f.t.run((ctx) => ctx.db.get(f.jobId))).toMatchObject({ resultJson: oldJson });
  expect(await f.t.run((ctx) => ctx.db.query("findingDecisions").collect())).toMatchObject([{ source: "migration", after: "fixed" }]);
});
