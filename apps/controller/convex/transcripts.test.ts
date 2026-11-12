import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { connectProject, delivery, modules, testTokenKey } from "./test.setup";

const auth = { workerSecret: "test-worker-secret" };
const admin = { adminSecret: "test-admin-secret" };
const project = { gitlabProjectId: "42", path: "group/repo" };
const trigger = { project, mrIid: 1, headSha: "A", provider: "fred" as const, kind: "push" as const, triggeredBy: "7", budgetOwner: { gitlabUserId: "7" } };
const attempt = { stage: "detect" as const, model: "m", effort: "high", outcome: "failed" as const, turns: 2, toolCalls: 1, durationMs: 50 };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-01T10:00:00Z"));
  vi.stubEnv("WORKER_SECRET", auth.workerSecret);
  vi.stubEnv("ADMIN_SECRET", admin.adminSecret);
  vi.stubEnv("FRED_TOKEN_KEY", testTokenKey);
  vi.stubEnv("FRED_MAINTENANCE_MODE", undefined);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

// A claimed job whose project collected transcripts at enqueue, or not.
async function running(collect: boolean) {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => { await ctx.db.insert("settings", { globalEnabled: true, defaultBudgetUsd: 3000, orgTimezone: "Europe/Berlin" }); });
  await connectProject(t, project);
  await t.mutation(internal.transcripts.setCollection, { projectPath: project.path, enabled: collect });
  await t.mutation(internal.enqueue.enqueue, { ...trigger, ...delivery() });
  const job = await t.mutation(api.jobs.claim, { ...auth, workerId: "one" });
  if (job?.kind !== "review") throw new Error("expected a claimed job");
  const stored = () => t.run(async (ctx) => ({
    rows: await ctx.db.query("transcripts").collect(), blobs: await ctx.db.system.query("_storage").collect(),
    audit: await ctx.db.query("policyAudit").collect(),
  }));
  return { t, job, lease: { ...auth, jobId: job._id, leaseToken: job.leaseToken }, stored };
}

const file = () => new TextEncoder().encode("gzipped transcript").buffer;

describe("transcript collection", () => {
  it.each([true, false])("snapshots the project switch onto a new job and audits it (collect: %s)", async (collect) => {
    const { job, stored } = await running(collect);
    expect(job.collectTranscripts).toBe(collect ? true : undefined);
    expect((await stored()).audit).toMatchObject([{ actor: "dashboard", table: "projects", after: JSON.stringify({ collectTranscripts: collect }) }]);
  });

  it("switches collection from the admin UI for jobs queued afterwards", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => { await ctx.db.insert("settings", { globalEnabled: true, defaultBudgetUsd: 3000, orgTimezone: "Europe/Berlin" }); });
    const projectId = await connectProject(t, project);
    const enable = { projectId, enabled: true };
    await expect(t.mutation(api.admin.setTranscriptCollection, { adminSecret: "wrong", ...enable })).rejects.toThrow(/unauthorized/);
    await t.mutation(api.admin.setTranscriptCollection, { ...admin, ...enable });
    const { projects } = await t.query(api.admin.projects, admin);
    expect(projects).toMatchObject([{ projectId, collectTranscripts: true }]);
    await t.mutation(internal.enqueue.enqueue, { ...trigger, ...delivery() });
    const job = await t.mutation(api.jobs.claim, { ...auth, workerId: "one" });
    expect(job).toMatchObject({ kind: "review", collectTranscripts: true });
    const audit = await t.run((ctx) => ctx.db.query("policyAudit").collect());
    expect(audit).toMatchObject([{ actor: "admin", table: "projects", rowId: projectId, before: JSON.stringify({ collectTranscripts: false }) }]);
  });

  it("stores one row and file per stage attempt and keeps the first on a retry", async () => {
    const { t, job, lease, stored } = await running(true);
    await t.action(api.transcripts.store, { ...lease, ...attempt, file: file() });
    await t.action(api.transcripts.store, { ...lease, ...attempt, file: file() });
    const { rows, blobs } = await stored();
    expect(rows).toMatchObject([{ jobId: job._id, leaseGeneration: 1, stage: "detect", outcome: "failed", bytes: 18 }]);
    expect(blobs.map((blob) => blob._id)).toEqual([rows[0]?.storageId]);
  });

  it("rejects a lost lease and a job queued without collection before storing a file", async () => {
    const collecting = await running(true);
    await expect(collecting.t.action(api.transcripts.store, { ...collecting.lease, leaseToken: "stale", ...attempt, file: file() })).rejects.toThrow(/lease lost/);
    const off = await running(false);
    await expect(off.t.action(api.transcripts.store, { ...off.lease, ...attempt, file: file() })).rejects.toThrow(/transcript_collection_off/);
    for (const { stored } of [collecting, off]) expect(await stored()).toMatchObject({ rows: [], blobs: [] });
  });

  it("deletes a job's files and rows and audits the deletion", async () => {
    const { t, job, lease, stored } = await running(true);
    await t.action(api.transcripts.store, { ...lease, ...attempt, file: file() });
    await t.action(api.transcripts.store, { ...lease, ...attempt, stage: "validate", file: file() });
    expect(await t.mutation(internal.transcripts.deleteForJob, { jobId: job._id })).toEqual({ deleted: 2 });
    const { rows, blobs, audit } = await stored();
    expect({ rows, blobs }).toEqual({ rows: [], blobs: [] });
    expect(audit.at(-1)).toMatchObject({ table: "transcripts", rowId: job._id, before: JSON.stringify({ transcripts: 2 }) });
  });

  it("downloads a stored file only with the admin secret", async () => {
    const { t, job, lease, stored } = await running(true);
    await t.action(api.transcripts.store, { ...lease, ...attempt, file: file() });
    const transcriptId = (await stored()).rows[0]!._id;
    await expect(t.action(api.admin.downloadTranscript, { adminSecret: "wrong", transcriptId })).rejects.toThrow(/unauthorized/);
    const download = await t.action(api.admin.downloadTranscript, { ...admin, transcriptId });
    expect(download.fileName).toBe(`fred-${job._id}-detect-g1.json.gz`);
    expect(new TextDecoder().decode(download.bytes)).toBe("gzipped transcript");
  });
});
