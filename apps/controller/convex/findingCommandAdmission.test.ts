import { decisionPublication } from "@fred/contracts";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { connectProject, delivery, modules, testTokenKey } from "./test.setup";

const auth = { workerSecret: "worker-test" };
const claim = { ...auth, workerId: "worker" };

beforeEach(() => {
  vi.stubEnv("WORKER_SECRET", auth.workerSecret);
  vi.stubEnv("FRED_TOKEN_KEY", testTokenKey);
  vi.stubEnv("GITLAB_URL", "https://gitlab.example");
});
afterEach(() => vi.unstubAllEnvs());

async function publishing(inline: boolean, admitUndo = true) {
  const t = convexTest(schema, modules);
  const projectId = await connectProject(t, { gitlabProjectId: "7", path: "group/repo" });
  const findingId = await t.run(async (ctx) => {
    await ctx.db.insert("settings", { globalEnabled: true, defaultBudgetUsd: 100, orgTimezone: "Europe/Berlin" });
    const developerId = await ctx.db.insert("developers", { gitlabUserId: "42" });
    const jobId = await ctx.db.insert("reviewJobs", { projectId, developerId, provider: "fred", mrIid: 1,
      headSha: "A", status: "done", triggeredBy: "42", summaryNoteId: "10" });
    return ctx.db.insert("findings", { projectId, jobId, provider: "fred", mrIid: 1,
      file: "file.ts", title: "Concern", body: "Original evidence", severity: "should_fix", status: "posted", disposition: "open",
      ...(inline ? { discussionId: "thread", noteId: "11" } : {}),
    });
  });
  await t.mutation(internal.enqueue.enqueue, { ...delivery(), provider: "fred", kind: "push", headSha: "B", mrIid: 1,
    project: { gitlabProjectId: "7", path: "group/repo" }, triggeredBy: "42", budgetOwner: { gitlabUserId: "42" } });
  const review = await t.mutation(api.jobs.claim, claim);
  if (!review || review.kind !== "review") throw new Error("expected review");
  const lease = { ...auth, jobId: review._id, leaseToken: review.leaseToken };
  const reference = `${review._id}:decision:${findingId}`;
  await t.mutation(api.jobs.saveResult, { ...lease, resultJson: JSON.stringify({ findings: [],
    findingDecisions: [{ findingId, disposition: "retracted", reason: "The earlier requirement was incorrect.", expectedDecisionId: null }],
    effects: [
      { key: "summary", kind: "summary", body: `Retracted. Undo with fred undo ${reference} <reason>.`, findingIndexes: [] },
      ...(inline ? [{ key: "resolve", kind: "resolve", findingId, discussionId: "thread", body: "Retracted." }] : []),
      { key: "label", kind: "label", label: "fred-review::clean", removeLabel: "fred-review::findings" },
    ],
  }) });
  await t.mutation(api.jobs.ackPublication, { ...lease, effectKey: "summary", noteId: "20" });
  expect(await t.run((ctx) => ctx.db.query("findingDecisions").collect())).toEqual([]);
  const enqueueUndo = () => t.mutation(internal.findingCommands.enqueue, { gitlabProjectId: "7",
    mrIid: 1, actorId: "42", noteId: "21", action: "undo", reference, reason: "The original requirement still applies." });
  if (admitUndo) expect(await enqueueUndo()).toHaveProperty("commandId");
  expect(await t.run((ctx) => ctx.db.query("mrNotes").collect())).toEqual([]);
  expect(await t.mutation(api.jobs.claim, { ...claim, workerId: "another" })).toBeNull();
  return { t, findingId, lease, reference, enqueueUndo };
}

it.each([false, true])("waits for an advertised retraction before applying undo, inline: %s", async (inline) => {
  const f = await publishing(inline);
  if (inline) await f.t.mutation(api.jobs.ackPublication, { ...f.lease, effectKey: "resolve" });
  await f.t.mutation(api.jobs.ackPublication, { ...f.lease, effectKey: "label" });
  await f.t.mutation(api.jobs.complete, f.lease);
  const command = await f.t.mutation(api.jobs.claim, claim);
  if (!command || command.kind !== "finding_command") throw new Error("expected command");
  expect(command.expectedDecisionRef).toBe(f.reference);
  const publication = await f.t.mutation(api.findingCommands.prepare, { ...auth, commandId: command._id, leaseToken: command.leaseToken });
  expect(decisionPublication.parse(JSON.parse(publication!))).toMatchObject({ resolved: false, label: "findings" });
  expect(await f.t.run((ctx) => ctx.db.get(f.findingId))).toMatchObject({ disposition: "open", body: "Original evidence" });
  expect(await f.t.run((ctx) => ctx.db.query("findingDecisions").collect())).toMatchObject([
    { before: "open", after: "retracted", source: "validator" },
    { before: "retracted", after: "open", source: "human" },
  ]);
});

it("rejects undo safely when publication relinquishes ownership without applying its decision", async () => {
  const f = await publishing(false);
  await f.t.mutation(api.jobs.fail, { ...f.lease, failureReason: "error" });
  const command = await f.t.mutation(api.jobs.claim, claim);
  if (!command || command.kind !== "finding_command") throw new Error("expected command");
  expect(await f.t.mutation(api.findingCommands.prepare, { ...auth, commandId: command._id, leaseToken: command.leaseToken })).toBeNull();
  expect(await f.t.run((ctx) => ctx.db.get(f.findingId))).toMatchObject({ disposition: "open" });
  expect(await f.t.run((ctx) => ctx.db.query("findingDecisions").collect())).toEqual([]);
  const notes = await f.t.run((ctx) => ctx.db.query("mrNotes").collect());
  expect(notes.some((note) => note.body.startsWith("Finding command rejected: That decision was never applied;"))).toBe(true);
});

it.each([false, true].flatMap((inline) => [false, true].map((admitBeforeFailure) => ({ inline, admitBeforeFailure }))))(
  "finishes recovered publication before undo (inline: $inline, admitted before failure: $admitBeforeFailure)",
  async ({ inline, admitBeforeFailure }) => {
    const f = await publishing(inline, admitBeforeFailure);
    await f.t.mutation(api.jobs.fail, { ...f.lease, failureReason: "error" });
    expect(await f.t.mutation(internal.enqueue.enqueue, { provider: "fred", kind: "reviewer_added", deliveryKey: "recover-publication",
      headSha: "B", mrIid: 1, project: { gitlabProjectId: "7", path: "group/repo" }, triggeredBy: "42", budgetOwner: { gitlabUserId: "42" } }))
      .toEqual({ result: "queued", jobId: f.lease.jobId });
    if (!admitBeforeFailure) expect(await f.enqueueUndo()).toHaveProperty("commandId");
    const recovered = await f.t.mutation(api.jobs.claim, claim);
    if (!recovered || recovered.kind !== "review") throw new Error("expected recovered publication before undo");
    expect(recovered).toMatchObject({ _id: f.lease.jobId, status: "publishing" });
    const lease = { ...auth, jobId: recovered._id, leaseToken: recovered.leaseToken };
    if (inline) await f.t.mutation(api.jobs.ackPublication, { ...lease, effectKey: "resolve" });
    await f.t.mutation(api.jobs.ackPublication, { ...lease, effectKey: "label" });
    await f.t.mutation(api.jobs.complete, lease);
    const command = await f.t.mutation(api.jobs.claim, claim);
    if (!command || command.kind !== "finding_command") throw new Error("expected undo after recovered publication");
    expect(await f.t.mutation(api.findingCommands.prepare, { ...auth, commandId: command._id, leaseToken: command.leaseToken })).not.toBeNull();
    expect(await f.t.run((ctx) => ctx.db.get(f.findingId))).toMatchObject({ disposition: "open" });
    expect(await f.t.run((ctx) => ctx.db.query("findingDecisions").collect())).toMatchObject([
      { before: "open", after: "retracted", source: "validator" },
      { before: "retracted", after: "open", source: "human" },
    ]);
    const notes = await f.t.run((ctx) => ctx.db.query("mrNotes").collect());
    expect(notes.some((note) => note.body.startsWith("Finding command rejected:"))).toBe(false);
  },
);

it.each(["failed", "superseded"] as const)("explains an unapplied decision from a %s review at admission", async (status) => {
  const f = await publishing(false, false);
  if (status === "failed") await f.t.mutation(api.jobs.fail, { ...f.lease, failureReason: "error" });
  else await f.t.mutation(api.jobs.supersede, f.lease);
  expect(await f.enqueueUndo()).toEqual({ rejected: true });
  expect(await f.t.run((ctx) => ctx.db.query("findingCommands").collect())).toEqual([]);
  expect(await f.t.run((ctx) => ctx.db.query("findingDecisions").collect())).toEqual([]);
  const notes = await f.t.run((ctx) => ctx.db.query("mrNotes").collect());
  expect(notes.some((note) => note.body.startsWith("Finding command rejected: That decision was never applied;"))).toBe(true);
});
