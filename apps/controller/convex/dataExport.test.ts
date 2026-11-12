import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { connectProject, fixtureBot, modules, testTokenKey } from "./test.setup";

const admin = { adminSecret: "test-admin-secret" };

beforeEach(() => vi.stubEnv("ADMIN_SECRET", admin.adminSecret));
afterEach(() => vi.unstubAllEnvs());

// A project with `jobs` leased review jobs, at least one, a transcript with a file and one without, and a leased finding command.
async function seeded(jobs: number) {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", { gitlabProjectId: "42", path: "group/repo" });
    const developerId = await ctx.db.insert("developers", { gitlabUserId: "7" });
    const lease = { workerId: "one", leaseToken: "secret-lease", leaseGeneration: 1 };
    const job = (mrIid: number) => ({ projectId, developerId, mrIid, headSha: "A", provider: "claude" as const, status: "running" as const, triggeredBy: "7", ...lease });
    const jobId = await ctx.db.insert("reviewJobs", job(0));
    for (let mrIid = 1; mrIid < jobs; mrIid++) await ctx.db.insert("reviewJobs", job(mrIid));
    const attempt = { jobId, leaseGeneration: 1, model: "m", effort: "high", outcome: "completed" as const, turns: 1, toolCalls: 0, durationMs: 5, recordedAt: 0 };
    const storageId = await ctx.storage.store(new Blob(["gzipped"]));
    await ctx.db.insert("transcripts", { ...attempt, stage: "detect", storageId, bytes: 7 });
    await ctx.db.insert("transcripts", { ...attempt, stage: "validate", omitted: "too_large", bytes: 0 });
    const findingId = await ctx.db.insert("findings", { jobId, projectId, mrIid: 0, provider: "claude", file: "a.ts", severity: "nit", title: "t", body: "b", status: "posted" });
    await ctx.db.insert("findingCommands", { projectId, mrIid: 0, provider: "claude", noteId: "1", actorId: "7", action: "dismiss", findingId,
      expectedDecisionRef: null, reason: "r", status: "running", publicationAcks: [], ...lease });
  });
  return t;
}

// Every row of one table, read page by page the way the admin UI does.
async function exportAll(t: Awaited<ReturnType<typeof seeded>>, table: "reviewJobs" | "transcripts" | "findingCommands" | "projectTokens") {
  const read = (cursor: string | null) => t.query(api.admin.exportPage, { ...admin, table, cursor });
  let page = await read(null);
  const pages = [page];
  while (!page.isDone) pages.push(page = await read(page.continueCursor));
  return { rows: pages.flatMap((each) => each.rows), pages: pages.length };
}

describe("data export", () => {
  it("lists every table except webhook deliveries", async () => {
    const t = await seeded(1);
    const manifest = await t.query(api.admin.exportManifest, admin);
    expect(manifest.formatVersion).toBe("fred-export/1");
    expect(manifest.tables).toContain("transcripts");
    expect(manifest.tables).not.toContain("webhookDeliveries");
  });

  it("pages through a table returning every row once", async () => {
    const t = await seeded(25);
    const { rows, pages } = await exportAll(t, "reviewJobs");
    expect(pages).toBeGreaterThan(1);
    expect(rows.map((row) => row.mrIid)).toEqual(Array.from({ length: 25 }, (_, index) => index));
    expect(new Set(rows.map((row) => row._id)).size).toBe(25);
  });

  it("omits lease tokens and storage IDs", async () => {
    const t = await seeded(1);
    const exported = [(await exportAll(t, "reviewJobs")).rows, (await exportAll(t, "findingCommands")).rows];
    for (const row of exported.flat()) expect(row).toMatchObject({ workerId: "one", leaseGeneration: 1 });
    expect(JSON.stringify(exported)).not.toContain("secret-lease");
    const transcripts = (await exportAll(t, "transcripts")).rows;
    expect(transcripts.map((row) => [row.stage, row.available, "storageId" in row])).toEqual([["detect", true, false], ["validate", false, false]]);
  });

  it("omits the sealed project token and keeps its metadata", async () => {
    vi.stubEnv("FRED_TOKEN_KEY", testTokenKey);
    const t = await seeded(1);
    await connectProject(t);
    const { rows } = await exportAll(t, "projectTokens");
    expect(rows).toMatchObject([{ name: "0 FRED", botUserId: fixtureBot.botUserId }]);
    expect(rows.map((row) => "sealedToken" in row)).toEqual([false]);
  });

  it("rejects a wrong admin secret", async () => {
    const t = await seeded(1);
    await expect(t.query(api.admin.exportManifest, { adminSecret: "wrong" })).rejects.toThrow(/unauthorized/);
    await expect(t.query(api.admin.exportPage, { adminSecret: "wrong", table: "reviewJobs", cursor: null })).rejects.toThrow(/unauthorized/);
  });
});
