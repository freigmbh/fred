import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { LEASE_MS } from "./lease";
import schema from "./schema";
import { connectProject, modules, testTokenKey } from "./test.setup";

const auth = { workerSecret: "migration-test" };

beforeEach(() => {
  vi.stubEnv("WORKER_SECRET", auth.workerSecret);
  vi.stubEnv("FRED_TOKEN_KEY", testTokenKey);
  vi.stubEnv("FRED_MAINTENANCE_MODE", undefined);
});
afterEach(() => vi.unstubAllEnvs());

it.each([false, true])(
  "recovers partially published legacy decisions after migration (remaining finding inline: %s)",
  async (inline) => {
    const t = convexTest(schema, modules);
    const projectId = await connectProject(t, { gitlabProjectId: "7", path: "group/repo" });
    const fixture = await t.run(async (ctx) => {
      await ctx.db.insert("settings", { globalEnabled: true, defaultBudgetUsd: 100, orgTimezone: "Europe/Berlin" });
      const developerId = await ctx.db.insert("developers", { gitlabUserId: "42" });
      const scope = { projectId, developerId, provider: "fred" as const, mrIid: 1, triggeredBy: "42" };
      const previousJobId = await ctx.db.insert("reviewJobs", { ...scope, headSha: "A", status: "done" });
      const finding = { projectId, jobId: previousJobId, provider: "fred" as const, mrIid: 1,
        file: "file.ts", title: "Concern", body: "Evidence", severity: "should_fix" as const };
      const fixedId = await ctx.db.insert("findings", { ...finding, status: "resolved", discussionId: "fixed-thread", resultIndex: 0 });
      const openId = await ctx.db.insert("findings", { ...finding, status: "posted", resultIndex: 1,
        ...(inline ? { discussionId: "open-thread" } : {}) });
      const effects = [
        { kind: "summary", key: "summary", body: "Both earlier findings were fixed.", findingIndexes: [] },
        { kind: "resolve", key: "resolve:fixed", findingId: fixedId, discussionId: "fixed-thread", body: "Fixed in B." },
        ...(inline ? [{ kind: "resolve", key: "resolve:open", findingId: openId, discussionId: "open-thread", body: "Fixed in B." }] : []),
        { kind: "label", key: "label", label: "fred-review::clean", removeLabel: "fred-review::findings" },
      ];
      const resultJson = JSON.stringify({ findings: [], resolvedFindingIds: [fixedId, openId], effects }, null, 2);
      const publicationAcks = [{ key: "summary" }, { key: "resolve:fixed" }];
      const jobId = await ctx.db.insert("reviewJobs", { ...scope, headSha: "B", status: "publishing", resultJson,
        publicationAcks, workerId: "legacy-worker", leaseToken: "legacy-lease", leaseGeneration: 1, leaseExpiresAt: Date.now() + LEASE_MS });
      return { jobId, fixedId, openId, resultJson, publicationAcks };
    });
    await t.mutation(api.jobs.fail, { ...auth, jobId: fixture.jobId, leaseToken: "legacy-lease", failureReason: "error", message: "GitLab publication failed" });
    expect(await t.run((ctx) => ctx.db.get(fixture.jobId))).toMatchObject({ status: "failed", resultJson: fixture.resultJson, publicationAcks: fixture.publicationAcks });

    expect(await t.mutation(internal.migrations.backfillFindingDisposition, {})).toEqual({ patched: 2, remaining: false });
    expect(await t.mutation(internal.migrations.backfillFindingDisposition, {})).toEqual({ patched: 0, remaining: false });
    const imported = await t.run((ctx) => ctx.db.query("findingDecisions").collect());
    expect(imported).toMatchObject([{ findingId: fixture.fixedId, source: "migration", before: "fixed", after: "fixed", actorId: "legacy" }]);
    expect(imported[0]?.reason).toContain("original decision metadata is unavailable");
    expect(await t.run((ctx) => ctx.db.get(fixture.fixedId))).toMatchObject({ status: "posted", disposition: "fixed", decisionId: imported[0]!._id });

    expect(await t.mutation(internal.enqueue.enqueue, { provider: "fred", kind: "reviewer_added", deliveryKey: "after-migration", headSha: "B", mrIid: 1,
      project: { gitlabProjectId: "7", path: "group/repo" }, triggeredBy: "42", budgetOwner: { gitlabUserId: "42" } })).toEqual({ result: "queued", jobId: fixture.jobId });
    const recovered = await t.mutation(api.jobs.claim, { ...auth, workerId: "recovered-worker" });
    if (recovered?.kind !== "review") throw new Error("expected recovered review publication");
    expect(recovered).toMatchObject({ _id: fixture.jobId, status: "publishing", resultJson: fixture.resultJson, publicationAcks: fixture.publicationAcks });
    const lease = { ...auth, jobId: recovered._id, leaseToken: recovered.leaseToken };
    expect(await t.mutation(api.jobs.heartbeat, lease)).toMatchObject({ publicationCurrent: true });

    if (inline) await t.mutation(api.jobs.ackPublication, { ...lease, effectKey: "resolve:open" });
    await t.mutation(api.jobs.ackPublication, { ...lease, effectKey: "label" });
    await t.mutation(api.jobs.complete, lease);
    await t.mutation(api.jobs.complete, lease);
    expect(await t.run((ctx) => ctx.db.get(fixture.jobId))).toMatchObject({ status: "done", resultJson: fixture.resultJson });
    expect(await t.run((ctx) => ctx.db.get(fixture.fixedId))).toMatchObject({ disposition: "fixed", decisionId: imported[0]!._id });
    expect(await t.run((ctx) => ctx.db.get(fixture.openId))).toMatchObject({ status: "posted", disposition: "fixed" });
    const decisions = await t.run((ctx) => ctx.db.query("findingDecisions").collect());
    expect(decisions).toHaveLength(2);
    expect(decisions[0]).toEqual(imported[0]);
    expect(decisions[1]).toMatchObject({ findingId: fixture.openId, source: "validator", before: "open", after: "fixed", jobId: fixture.jobId, headSha: "B" });
    expect(await t.run((ctx) => ctx.db.query("reviewJobs").collect())).toHaveLength(2);
    expect(await t.run((ctx) => ctx.db.query("usageEvents").collect())).toEqual([]);
  },
);
