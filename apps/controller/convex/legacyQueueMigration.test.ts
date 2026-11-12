import { convexTest } from "convex-test";
import { expect, it } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { modules } from "./test.setup";

it("supersedes queued and publishing reviews of the retired bots and fails their queued finding commands, leaving FRED and running work alone", async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", { gitlabProjectId: "7", path: "group/repo" });
    const developerId = await ctx.db.insert("developers", { gitlabUserId: "42" });
    const job = (provider: "claude" | "codex" | "fred", status: "queued" | "running" | "publishing") =>
      ctx.db.insert("reviewJobs", { projectId, developerId, provider, status, mrIid: 1, headSha: "A", triggeredBy: "42" });
    for (const provider of ["claude", "codex", "fred"] as const) await job(provider, "queued");
    const jobId = await job("claude", "running");
    await job("codex", "publishing");
    const findingId = await ctx.db.insert("findings", { projectId, jobId, provider: "claude", mrIid: 1, status: "posted",
      disposition: "open", file: "a.ts", title: "Concern", body: "Evidence", severity: "should_fix" });
    for (const provider of ["claude", "codex", "fred"] as const) {
      await ctx.db.insert("findingCommands", { projectId, mrIid: 1, provider, noteId: provider, actorId: "42", action: "dismiss", findingId,
        expectedDecisionRef: null, reason: "Intentional.", status: "queued", publicationAcks: [] });
    }
  });

  expect(await t.mutation(internal.migrations.retireLegacyQueue, {})).toEqual({ jobs: 3, commands: 2, remaining: false });
  expect(await t.run((ctx) => ctx.db.query("reviewJobs").collect())).toMatchObject([
    { provider: "claude", status: "superseded" }, { provider: "codex", status: "superseded" },
    { provider: "fred", status: "queued" }, { provider: "claude", status: "running" }, { provider: "codex", status: "superseded" },
  ]);
  expect(await t.run((ctx) => ctx.db.query("findingCommands").collect())).toMatchObject([
    { provider: "claude", status: "failed", failure: "retired reviewer account" },
    { provider: "codex", status: "failed", failure: "retired reviewer account" },
    { provider: "fred", status: "queued" },
  ]);
  expect(await t.mutation(internal.migrations.retireLegacyQueue, {})).toEqual({ jobs: 0, commands: 0, remaining: false });
});
