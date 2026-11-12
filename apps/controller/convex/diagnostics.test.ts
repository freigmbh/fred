import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { captureJob, diagnosticRetentionMs } from "./diagnosticCapture";
import { LEASE_MS } from "./lease";
import schema from "./schema";
import { connectProject, delivery, modules, testTokenKey } from "./test.setup";

const auth = { workerSecret: "worker-test" };
const trigger = { provider: "fred" as const, kind: "push" as const, headSha: "A", mrIid: 1,
  project: { gitlabProjectId: "7", path: "group/a" }, triggeredBy: "42", budgetOwner: { gitlabUserId: "42" } };
const event = () => ({ kind: "provider_activity", phase: "detect", at: Date.now() } as const);
const snapshot = () => ({ phase: "detect", at: Date.now(), lastActivityAt: Date.now(), droppedEvents: 0, leaseGeneration: 1 } as const);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-07T12:00:00Z"));
  vi.stubEnv("WORKER_SECRET", auth.workerSecret);
  vi.stubEnv("GITLAB_WEBHOOK_SECRET", "webhook-test");
  vi.stubEnv("FRED_TOKEN_KEY", testTokenKey);
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
  const job = await t.mutation(api.jobs.claim, { ...auth, workerId: "test" });
  if (job?.kind !== "review") throw new Error("expected job");
  return { job, lease: { ...auth, jobId: job._id, leaseToken: job.leaseToken } };
}

it("requires worker authorization and rejects unbounded or unrecognized data", async () => {
  const t = await setup();
  const { lease } = await running(t);
  await expect(t.mutation(api.diagnostics.record, { ...lease, workerSecret: "admin-key", eventsJson: "[]" })).rejects.toThrow(/unauthorized/);
  for (const events of [[{ ...event(), body: "source code" }], Array.from({ length: 26 }, event), [{ ...event(), tool: "shell" }]]) {
    await expect(t.mutation(api.diagnostics.record, { ...lease, eventsJson: JSON.stringify(events) })).rejects.toThrow();
  }
  await expect(t.mutation(api.diagnostics.record, { ...lease, eventsJson: " ".repeat(131_073) })).rejects.toThrow(/too large/);
  await expect(t.mutation(api.diagnostics.record, { ...lease, eventsJson: "[]", snapshotJson: JSON.stringify({ ...snapshot(), leaseGeneration: 99 }) })).rejects.toThrow(/generation mismatch/);
});

it("reports retired model selections after configuration failure while rejecting unsafe identifiers", async () => {
  const t = await setup();
  const { job, lease } = await running(t);
  const stageModels = { detect: { model: "retired-model", effort: "minimal" }, validate: { model: "gpt-6-astra", effort: "medium" } };
  await t.run((ctx) => ctx.db.patch(job._id, { stageModels }));
  await t.mutation(api.jobs.fail, { ...lease, failureReason: "error", diagnosticJson: JSON.stringify({ ...snapshot(), failure: { category: "configuration" } }) });
  const report = await t.query(internal.diagnostics.inspect, { jobId: lease.jobId });
  expect(report.jobs[0]).toMatchObject({ status: "failed", stageModels, snapshot: { failure: { category: "configuration" } } });
  await t.run((ctx) => ctx.db.patch(job._id, { stageModels: { ...stageModels, detect: { model: "PRIVATE SOURCE\n", effort: "minimal" } } }));
  const unsafe = await t.query(internal.diagnostics.inspect, { jobId: lease.jobId });
  expect(unsafe.jobs[0]?.stageModels).toBeNull();
  expect(JSON.stringify(unsafe)).not.toContain("PRIVATE SOURCE");
});

it("keeps terminal failure, activity and dropped counts when batches arrive out of order", async () => {
  const t = await setup();
  const { lease } = await running(t);
  const first = snapshot();
  await t.mutation(api.diagnostics.record, { ...lease, eventsJson: JSON.stringify([event()]), snapshotJson: JSON.stringify({ ...first, failure: { category: "authentication", httpStatus: 401 }, droppedEvents: 3 }) });
  await t.mutation(api.jobs.fail, { ...lease, failureReason: "error", message: "unsafe provider stderr", diagnosticJson: JSON.stringify({ ...first, failure: { category: "authentication", httpStatus: 401 } }) });
  await t.mutation(api.diagnostics.record, { ...lease, eventsJson: "[]", snapshotJson: JSON.stringify({ ...first, phase: "checkout", at: first.at - 1000, lastActivityAt: first.at - 1000 }) });
  const report = await t.query(internal.diagnostics.inspect, { jobId: lease.jobId });
  expect(report.jobs[0]).toMatchObject({ status: "failed", snapshot: { phase: "detect", failure: { category: "authentication" }, lastActivityAt: first.at, droppedEvents: 3 } });
  const notes = await t.run((ctx) => ctx.db.query("mrNotes").collect());
  expect(notes).toHaveLength(1);
  expect(notes[0]?.body).toContain("Provider authentication failed");
  expect(notes[0]?.body).toContain(lease.jobId);
  expect(notes[0]?.body).not.toContain("unsafe");
});

it("retains diff recovery failures and queues one safe MR comment", async () => {
  const t = await setup();
  const { lease } = await running(t);
  const failure = { category: "gitlab", code: "diff_recovery_failed" };
  const args = { ...lease, failureReason: "error" as const, message: "PRIVATE_SOURCE", diagnosticJson: JSON.stringify({ ...snapshot(), phase: "context", failure }) };
  await t.mutation(api.jobs.fail, args);
  await t.mutation(api.jobs.fail, args);
  const report = await t.query(internal.diagnostics.inspect, { jobId: lease.jobId });
  expect(report.jobs[0]).toMatchObject({ status: "failed", snapshot: { phase: "context", failure } });
  const notes = await t.run((ctx) => ctx.db.query("mrNotes").collect());
  expect(notes).toHaveLength(1);
  expect(notes[0]?.body).toContain("GitLab diff recovery failed; complete review input could not be verified");
  expect(notes[0]?.body).toContain(lease.jobId);
  expect(notes[0]?.body).not.toMatch(/PRIVATE_SOURCE|GitLab request failed/);
});

it.each(([
  ["string_too_long", "string that exceeds its length limit"],
  ["context_length_exceeded", "input that exceeds the model context window"],
  ["payload_too_large", "request that exceeds its payload size limit"],
] as const).map(([code, explanation]) => ({ code, explanation })))("retains $code sizes in events, terminal storage and its durable failure comment", async ({ code, explanation }) => {
  const t = await setup();
  const { lease } = await running(t);
  const failure = { category: "invalid_request", provider: { source: "openrouter", code }, httpStatus: 400,
    request: { bytes: 17_200_000, messageCount: 2, largestMessageCharacters: 17_000_000 } };
  await t.mutation(api.diagnostics.record, { ...lease, eventsJson: JSON.stringify([{ ...event(), kind: "api_rejected", httpStatus: 400, failure }]), snapshotJson: JSON.stringify({ ...snapshot(), failure }) });
  const args = { ...lease, failureReason: "error" as const, message: "PRIVATE_SOURCE sk-private", diagnosticJson: JSON.stringify({ ...snapshot(), failure }) };
  await t.mutation(api.jobs.fail, args);
  await t.mutation(api.jobs.fail, args);
  const report = await t.query(internal.diagnostics.inspect, { jobId: lease.jobId });
  expect(report.events.some(({ event }) => event.kind === "api_rejected" && event.failure?.request?.bytes === failure.request.bytes)).toBe(true);
  expect(report.jobs[0]).toMatchObject({ status: "failed", snapshot: { failure } });
  expect(report.notes).toMatchObject([{ failure }]);
  vi.setSystemTime(Date.now() + diagnosticRetentionMs);
  const retained = await t.query(internal.diagnostics.inspect, { jobId: lease.jobId });
  expect(retained.events).toEqual([]);
  expect(retained.jobs[0]).toMatchObject({ snapshot: { failure } });
  expect(retained.notes).toMatchObject([{ failure }]);
  const notes = await t.run((ctx) => ctx.db.query("mrNotes").collect());
  expect(notes).toHaveLength(1);
  expect(notes[0]?.body).toContain(explanation);
  expect(notes[0]?.body).toContain(lease.jobId);
  expect(JSON.stringify(retained) + notes[0]?.body).not.toMatch(/PRIVATE_SOURCE|sk-private/);
});

it("queues one safe local input-limit failure comment", async () => {
  const t = await setup();
  const { lease } = await running(t);
  const failure = { category: "invalid_request", code: "review_input_too_large" };
  const args = { ...lease, failureReason: "error" as const, message: "PRIVATE_SOURCE", diagnosticJson: JSON.stringify({ ...snapshot(), failure }) };
  await t.mutation(api.jobs.fail, args);
  await t.mutation(api.jobs.fail, args);
  const notes = await t.run((ctx) => ctx.db.query("mrNotes").collect());
  expect(notes).toHaveLength(1);
  expect(notes[0]?.body).toContain("Review input exceeds FRED's initial prompt limit");
  expect(notes[0]?.body).not.toContain("PRIVATE_SOURCE");
});

it("rejects invalid request counts and raw request fields before recording metadata", async () => {
  const t = await setup();
  const { lease } = await running(t);
  for (const request of [
    { bytes: -1, messageCount: 2, largestMessageCharacters: 1 },
    { bytes: 100, messageCount: 0.5, largestMessageCharacters: 1 },
    { bytes: 100, messageCount: 2, largestMessageCharacters: "PRIVATE_SOURCE" },
    { bytes: 100, messageCount: 2, largestMessageCharacters: 1, body: "PRIVATE_SOURCE" },
  ]) {
    const eventsJson = JSON.stringify([{ ...event(), kind: "api_rejected", failure: { category: "invalid_request", request } }]);
    await expect(t.mutation(api.diagnostics.record, { ...lease, eventsJson })).rejects.toThrow();
  }
});

it("fences expired and replaced publishers and permits the new terminal owner to flush", async () => {
  const t = await setup();
  const { lease } = await running(t);
  await t.mutation(api.jobs.saveResult, { ...lease, resultJson: JSON.stringify({ findings: [], resolvedFindingIds: [], effects: [{ kind: "summary", key: "s", body: "sensitive", findingIndexes: [] }] }) });
  vi.setSystemTime(Date.now() + LEASE_MS);
  await expect(t.mutation(api.diagnostics.record, { ...lease, eventsJson: "[]" })).rejects.toThrow(/lease lost/);
  const recovered = await t.mutation(api.jobs.claim, { ...auth, workerId: "new" });
  if (recovered?.kind !== "review") throw new Error("expected recovery");
  await expect(t.mutation(api.diagnostics.record, { ...lease, eventsJson: "[]" })).rejects.toThrow(/lease lost/);
  const owner = { ...lease, leaseToken: recovered.leaseToken };
  await t.mutation(api.jobs.ackPublication, { ...owner, effectKey: "s" });
  await t.mutation(api.jobs.complete, owner);
  await t.mutation(api.diagnostics.record, { ...owner, eventsJson: JSON.stringify([event()]), snapshotJson: JSON.stringify({ ...snapshot(), leaseGeneration: 2 }) });
  expect((await t.query(internal.diagnostics.inspect, { jobId: lease.jobId })).jobs[0]).toMatchObject({ status: "done", snapshot: { phase: "complete", leaseGeneration: 2 } });
});

it("does not let a worker repair its snapshot after controller expiry", async () => {
  const t = await setup();
  const { lease } = await running(t);
  vi.setSystemTime(Date.now() + LEASE_MS);
  await t.mutation(internal.stale.failStale, {});
  await expect(t.mutation(api.diagnostics.record, { ...lease, eventsJson: "[]" })).rejects.toThrow(/lease lost/);
});

it("keeps a missing legacy lease generation unspecified in worker events", async () => {
  const t = await setup();
  const { lease } = await running(t);
  await t.run((ctx) => ctx.db.patch(lease.jobId, { leaseGeneration: undefined, diagnosticJson: undefined }));
  await t.mutation(api.diagnostics.record, { ...lease, eventsJson: JSON.stringify([event()]) });
  const report = await t.query(internal.diagnostics.inspect, { jobId: lease.jobId });
  expect(report.events.find((row) => row.event.kind === "provider_activity")?.leaseGeneration).toBeNull();
});

it("does not broaden empty project selectors to recent records", async () => {
  const t = await setup();
  const { lease } = await running(t);
  await t.mutation(api.jobs.fail, { ...lease, failureReason: "error", message: "failure" });
  const recent = await t.query(internal.diagnostics.inspect, {});
  expect(recent.jobs.length).toBeGreaterThan(0);
  expect(recent.events.length).toBeGreaterThan(0);
  expect(recent.notes.length).toBeGreaterThan(0);
  for (const selector of [{ gitlabProjectId: "" }, { projectPath: "" }]) {
    const report = await t.query(internal.diagnostics.inspect, { ...selector });
    expect(report).toMatchObject({ jobs: [], events: [], notes: [], coverage: { empty: true } });
  }
});

it("returns failure text, usage gaps, and comment delivery errors without lease tokens", async () => {
  const t = await setup();
  const { lease } = await running(t);
  await t.mutation(api.jobs.fail, { ...lease, failureReason: "error", message: "legacy-sensitive" });
  await t.run(async (ctx) => {
    await ctx.db.patch(lease.jobId, { diagnosticJson: '{"phase":"detect","body":"legacy-sensitive"}', resultJson: "legacy-sensitive", usageIncompleteReason: "legacy-sensitive" });
    const note = await ctx.db.query("mrNotes").first();
    if (!note) throw new Error("expected note");
    await ctx.db.patch(note._id, { lastError: "legacy-sensitive", status: "failed", attempts: 5 });
  });
  const report = await t.query(internal.diagnostics.inspect, { projectPath: "group/a", mrIid: 1 });
  expect(JSON.stringify(report)).not.toContain(lease.leaseToken);
  expect(report.jobs[0]).toMatchObject({ snapshot: null, failureReason: "error", publication: { acknowledged: 0, total: null, resultUnreadable: true }, usage: { incompleteReason: "legacy-sensitive" } });
  expect(report.notes[0]).toMatchObject({ status: "failed", attempts: 5, lastError: "legacy-sensitive", body: expect.stringContaining("AI review failed") });
});

it("expires detailed events immediately and prunes bounded batches while snapshots remain", async () => {
  const t = await setup();
  const { lease } = await running(t);
  await t.mutation(api.diagnostics.record, { ...lease, eventsJson: JSON.stringify([event()]), snapshotJson: JSON.stringify(snapshot()) });
  vi.setSystemTime(Date.now() + diagnosticRetentionMs);
  expect((await t.query(internal.diagnostics.inspect, { jobId: lease.jobId })).events).toHaveLength(0);
  await t.run(async (ctx) => {
    for (let i = 0; i < 505; i++) await ctx.db.insert("diagnosticEvents", { eventJson: JSON.stringify(event()), recordedAt: Date.now() - diagnosticRetentionMs, expiresAt: Date.now() });
  });
  expect(await t.mutation(internal.diagnostics.prune, {})).toBe(500);
  expect(await t.run((ctx) => ctx.db.query("diagnosticEvents").collect())).toHaveLength(8);
  expect((await t.query(internal.diagnostics.inspect, { jobId: lease.jobId })).jobs[0]?.snapshot).not.toBeNull();
});

it("finds denied requests before a job exists and reports an empty unknown MR", async () => {
  const t = await setup();
  await t.run(async (ctx) => { const settings = await ctx.db.query("settings").first(); await ctx.db.patch(settings!._id, { globalEnabled: false }); });
  await t.mutation(internal.enqueue.enqueue, { ...trigger, ...delivery() });
  const report = await t.query(internal.diagnostics.inspect, { gitlabProjectId: "7", mrIid: 1 });
  expect(report.jobs).toHaveLength(0);
  expect(report.events).toMatchObject([{ event: { kind: "denied", reason: "disabled" } }]);
  expect(report.notes).toMatchObject([{ status: "pending", attempts: 0 }]);
  expect((await t.query(internal.diagnostics.inspect, { projectPath: "missing/project", mrIid: 1 })).coverage.empty).toBe(true);
});

it("records unauthorized and malformed webhooks without trusting body identifiers", async () => {
  const t = await setup();
  const body = JSON.stringify({ object_kind: "merge_request", project: { id: 7 }, object_attributes: { iid: 1 } });
  expect((await t.fetch("/webhook/gitlab", { method: "POST", body })).status).toBe(401);
  expect((await t.fetch("/webhook/gitlab", { method: "POST", headers: { "X-Gitlab-Token": "webhook-test" }, body })).status).toBe(400);
  const report = await t.query(internal.diagnostics.inspect, {});
  expect(report.events).toHaveLength(2);
  expect(report.events.every((row) => row.gitlabProjectId === null && row.mrIid === null)).toBe(true);
  expect(report.events.map(({ event }) => event.kind)).toEqual(["webhook_invalid", "webhook_unauthorized"]);
});

it("keeps a successful lifecycle mutation when diagnostic insertion fails", async () => {
  const t = await setup();
  const { job } = await running(t);
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  await t.run(async (ctx) => {
    await ctx.db.patch(job._id, { status: "superseded" });
    await captureJob({ ...ctx, db: { ...ctx.db, insert: async () => { throw new Error("sensitive persistence error"); } } }, job,
      { kind: "superseded", phase: "queue", at: Date.now(), reason: "new_head" });
  });
  expect(await t.run((ctx) => ctx.db.get(job._id))).toMatchObject({ status: "superseded" });
  expect(warning).toHaveBeenCalledWith("FRED controller diagnostic recording failed");
  warning.mockRestore();
});

it("reports bounded usage and event truncation instead of implying complete evidence", async () => {
  const t = await setup();
  const { job, lease } = await running(t);
  await t.run(async (ctx) => {
    for (let i = 0; i < 1001; i++) {
      if (i < 201) await ctx.db.insert("usageEvents", { jobId: job._id, developerId: job.developerId, month: "2026-09", provider: "fred", model: "m", stage: "detect", inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, costUsd: 1, priceTableVersion: "test" });
      await ctx.db.insert("diagnosticEvents", { jobId: job._id, eventJson: JSON.stringify(event()), recordedAt: Date.now(), expiresAt: Date.now() + diagnosticRetentionMs });
    }
  });
  const report = await t.query(internal.diagnostics.inspect, { jobId: lease.jobId });
  expect(report.jobs[0]?.usage).toMatchObject({ rows: 200, inputTokens: 200, truncated: true });
  expect(report.coverage.eventsTruncated).toBe(true);
  expect(report.events).toHaveLength(1000);
});

it("finds ignored webhooks by MR path before the project is registered", async () => {
  const t = await setup();
  const response = await t.fetch("/webhook/gitlab", { method: "POST", headers: { "X-Gitlab-Token": "webhook-test" }, body: JSON.stringify({
    object_kind: "merge_request", user: { id: 42, username: "user" }, project: { id: 7, path_with_namespace: "group/a" },
    object_attributes: { iid: 1, author_id: 42, action: "update", last_commit: { id: "A" } },
  }) });
  expect(response.status).toBe(200);
  const report = await t.query(internal.diagnostics.inspect, { projectPath: "group/a", mrIid: 1, provider: "fred" });
  expect(report.jobs).toHaveLength(0);
  expect(report.events.map(({ event }) => event.kind)).toEqual(["webhook_ignored", "webhook_received"]);
  expect(report.coverage.noWebhookReceipt).toBe(false);
});

it("includes the MR receipt in a job lookup and the note's delivery error", async () => {
  const t = await setup();
  await t.mutation(internal.diagnostics.webhook, { gitlabProjectId: "7", mrIid: 1, eventJson: JSON.stringify({ kind: "webhook_received", phase: "webhook", at: Date.now() }) });
  const { lease } = await running(t);
  await t.mutation(api.jobs.fail, { ...lease, failureReason: "error" });
  const note = await t.run((ctx) => ctx.db.query("mrNotes").first());
  if (!note) throw new Error("expected note");
  await t.mutation(internal.mrNotes.recordAttempt, { noteId: note._id, attempt: 1, retryable: true, error: "private response body" });
  const report = await t.query(internal.diagnostics.inspect, { jobId: lease.jobId });
  expect(report.coverage.noWebhookReceipt).toBe(false);
  expect(report.events.some(({ event }) => event.kind === "note_attempt" && event.outcome === "retry")).toBe(true);
  expect(report.notes[0]?.lastError).toContain("private response body");
});

it("redacts configured secrets from legacy failure notes before bounding text", async () => {
  const t = await setup();
  const { lease } = await running(t);
  vi.stubEnv("ANTHROPIC_API_KEY", "sensitive-api-key");
  await t.mutation(api.jobs.fail, { ...lease, failureReason: "error", message: "failed sensitive-api-key\nnext line" });
  const note = await t.run((ctx) => ctx.db.query("mrNotes").first());
  expect(note?.body).toBe(`AI review failed: failed [redacted] next line. Remove and re-add this reviewer to retry (job ${lease.jobId})`);
});

it("accepts the final failure phase after the owner has failed the job without rewriting its status", async () => {
  const t = await setup();
  const { lease } = await running(t);
  const failureSnapshot = { ...snapshot(), failure: { category: "process", code: "ENOENT" } };
  vi.setSystemTime(Date.now() + 100);
  await t.mutation(api.jobs.fail, { ...lease, failureReason: "error", message: "provider process failed" });
  await t.mutation(api.diagnostics.record, { ...lease, eventsJson: "[]", snapshotJson: JSON.stringify(failureSnapshot) });
  expect((await t.query(internal.diagnostics.inspect, { jobId: lease.jobId })).jobs[0]).toMatchObject({ status: "failed", snapshot: { phase: "detect", failure: { category: "process", code: "ENOENT" } } });
  expect(await t.run((ctx) => ctx.db.query("mrNotes").collect())).toHaveLength(1);
});

it("counts the publication effects of a result saved in the v1 format", async () => {
  const t = await setup();
  const { lease } = await running(t);
  const v1 = { findings: [], resolvedFindingIds: [], effects: [{ kind: "summary", key: "s", body: "s", findingIndexes: [] }] };
  await t.run((ctx) => ctx.db.patch(lease.jobId, { status: "publishing", resultJson: JSON.stringify(v1) }));
  expect((await t.query(internal.diagnostics.inspect, { jobId: lease.jobId })).jobs[0]?.publication).toMatchObject({ total: 1, resultUnreadable: false });
});

it("starts a recovered generation at publication despite a newer timestamp on the old snapshot", async () => {
  const t = await setup();
  const { lease } = await running(t);
  await t.mutation(api.jobs.saveResult, { ...lease, resultJson: JSON.stringify({ findings: [], resolvedFindingIds: [], effects: [{ kind: "summary", key: "s", body: "s", findingIndexes: [] }] }) });
  await t.mutation(api.diagnostics.record, { ...lease, eventsJson: "[]", snapshotJson: JSON.stringify({ ...snapshot(), phase: "save", at: Date.now() + 10 * LEASE_MS }) });
  vi.setSystemTime(Date.now() + LEASE_MS);
  await t.mutation(api.jobs.claim, { ...auth, workerId: "recovered" });
  expect((await t.query(internal.diagnostics.inspect, { jobId: lease.jobId })).jobs[0]?.snapshot).toMatchObject({ phase: "publish", leaseGeneration: 2 });
});

it("keeps high-frequency snapshots off job documents and delivers failure details without a diagnostic flush", async () => {
  const t = await setup();
  const { job, lease } = await running(t);
  const before = await t.run((ctx) => ctx.db.get(job._id));
  await t.mutation(api.diagnostics.record, { ...lease, eventsJson: JSON.stringify([event()]), snapshotJson: JSON.stringify(snapshot()) });
  expect(await t.run((ctx) => ctx.db.get(job._id))).toEqual(before);
  const failure = { category: "controller", controller: { operation: "jobs:recordUsage", reason: "timeout", elapsedMs: 15_000, connected: true } };
  await t.mutation(api.jobs.interruptAnalysis, { ...lease, diagnosticJson: JSON.stringify({ ...snapshot(), phase: "validate", failure }) });
  const report = await t.query(internal.diagnostics.inspect, { jobId: job._id });
  expect(report.jobs[0]).toMatchObject({ status: "failed", snapshot: { phase: "validate", failure } });
  expect(report.notes[0]).toMatchObject({ failure });
});

it("refuses retired runtime failures from workers and still reads and comments on stored ones", async () => {
  const t = await setup();
  const { lease } = await running(t);
  const failure = { category: "provider", provider: { source: "codex_rpc", code: "unknown", rpcCode: -32602 } };
  const stored = JSON.stringify({ ...snapshot(), failure });
  await expect(t.mutation(api.jobs.fail, { ...lease, failureReason: "error", diagnosticJson: stored })).rejects.toThrow();
  await t.run((ctx) => ctx.db.patch(lease.jobId, { diagnosticJson: stored }));
  await t.mutation(api.jobs.fail, { ...lease, failureReason: "error", message: "PRIVATE_SOURCE" });
  const report = await t.query(internal.diagnostics.inspect, { jobId: lease.jobId });
  expect(report.jobs[0]).toMatchObject({ status: "failed", snapshot: { failure } });
  expect(report.notes).toMatchObject([{ failure, body: expect.stringContaining("(codex_rpc, RPC -32602)") }]);
  expect(report.notes[0]?.body).not.toContain("PRIVATE_SOURCE");
});

it("keeps the redacted failure detail for operators and out of the MR comment", async () => {
  const t = await setup();
  const { lease } = await running(t);
  const failure = { category: "provider", detail: "ProviderError: OpenRouter ended without a complete review tool call (finish reason stop, 0 tool calls)" } as const;
  await t.mutation(api.jobs.fail, { ...lease, failureReason: "error", diagnosticJson: JSON.stringify({ ...snapshot(), phase: "validate", failure }) });
  const report = await t.query(internal.diagnostics.inspect, { jobId: lease.jobId });
  expect(report.jobs[0]).toMatchObject({ snapshot: { phase: "validate", failure }, failures: [{ kind: "failed", failureCategory: "provider" }] });
  expect(report.notes[0]?.failure).toEqual(failure);
  expect(report.notes[0]?.body).not.toContain("finish reason");
});
