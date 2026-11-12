import { defaultStageModels } from "@fred/contracts";
import { convexTest } from "convex-test";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import reviewerAdded from "../../../fixtures/webhooks/reviewer-added.json";
import { api, internal } from "./_generated/api";
import { unconnectedProject } from "./projectTokens";
import schema from "./schema";
import { delivery, fixtureProject, modules, testTokenKey } from "./test.setup";
import { openToken } from "./tokenVault";

const admin = { adminSecret: "test-admin" };
const worker = { workerSecret: "test-worker" };
const claim = { ...worker, workerId: "test" };
const changedPipeline = { detect: { model: "new-vendor/new-model", effort: "default" }, validate: { model: "anthropic/claude-fable-5.1", effort: "max" } };
const trigger = { provider: "fred" as const, kind: "reviewer_added" as const, deliveryKey: "first", headSha: "a", mrIid: 1,
  project: fixtureProject, triggeredBy: "42", budgetOwner: { gitlabUserId: "42" } };

const otherProject = { id: 8, path_with_namespace: "frei/other" };
// Project access tokens the fake GitLab knows: two successive "0 FRED" bots of the fixture project and one of another project.
const bots = new Map([
  ["glpat-first", { id: 901, project: { id: 7, path_with_namespace: fixtureProject.path } }],
  ["glpat-second", { id: 905, project: { id: 7, path_with_namespace: fixtureProject.path } }],
  ["glpat-other", { id: 801, project: otherProject }],
]);
const label = z.object({ name: z.string() });
const fredIcon = new Uint8Array(readFileSync(new URL("../../ui/public/fred-icon.png", import.meta.url)));

// Stubs fetch with a GitLab that answers for the tokens in `bots`. Change the returned state to revoke tokens, move their
// expiry, or refuse avatars. `avatars` holds the uploaded avatar bytes by bot user ID.
function fakeGitlab() {
  const state = { unauthorized: false, expiresAt: "2027-01-01" as string | null, labels: [] as string[], requests: 0,
    avatarRefused: false, avatars: new Map<number, Uint8Array>() };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    state.requests++;
    const bot = bots.get(new Headers(init?.headers).get("PRIVATE-TOKEN") ?? "");
    if (state.unauthorized || !bot) return new Response(null, { status: 401 });
    const path = new URL(String(input)).pathname.replace(/^\/api\/v4\//, "");
    const projectPath = `projects/${bot.project.id}`;
    if (path === "personal_access_tokens/self") {
      return Response.json({ id: bot.id, name: "0 FRED", scopes: ["api"], active: true, revoked: false, expires_at: state.expiresAt });
    }
    if (path === "user") return Response.json({ id: bot.id, username: `project_${bot.project.id}_bot_fred`, bot: true });
    if (path === "projects") return Response.json([bot.project]);
    if (path === `${projectPath}/members/all/${bot.id}`) return Response.json({ access_level: 30 });
    if (path === `${projectPath}/labels` && init?.method === "POST") {
      const created = label.parse(JSON.parse(String(init.body)));
      state.labels.push(created.name);
      return Response.json(created, { status: 201 });
    }
    if (path === `${projectPath}/labels`) return Response.json(state.labels.map((name) => ({ name })));
    if (path === "user/avatar" && init?.method === "PUT" && init.body instanceof FormData) {
      const avatar = init.body.get("avatar");
      if (state.avatarRefused || !(avatar instanceof Blob)) return new Response(null, { status: 403 });
      state.avatars.set(bot.id, new Uint8Array(await avatar.arrayBuffer()));
      return Response.json({ avatar_url: `https://gitlab.invalid/uploads/-/system/user/avatar/${bot.id}/avatar.png` });
    }
    throw new Error(`unexpected GitLab request ${String(input)}`);
  });
  return state;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("ADMIN_SECRET", admin.adminSecret);
  vi.stubEnv("WORKER_SECRET", worker.workerSecret);
  vi.stubEnv("GITLAB_WEBHOOK_SECRET", "hook-test");
  vi.stubEnv("GITLAB_URL", "https://gitlab.invalid");
  vi.stubEnv("FRED_TOKEN_KEY", testTokenKey);
  vi.stubEnv("FRED_MAINTENANCE_MODE", undefined);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const catalog = [
  { id: "anthropic/claude-fable-5.1", label: "Fable", efforts: ["default", "low", "medium", "high", "xhigh", "max"], defaultEffort: "high" },
  { id: "openai/gpt-6-astra", label: "Astra", efforts: ["default", "low", "medium", "high", "xhigh", "max"], defaultEffort: "medium" },
  { id: "new-vendor/new-model", label: "New model", efforts: ["default"], defaultEffort: "default" },
].map((model) => ({ ...model, contextLength: 100_000, maxCompletionTokens: 10_000, supportedParameters: ["tools"], reasoningMandatory: false }));

async function setup(withCatalog = true) {
  const t = convexTest(schema, modules);
  await t.run((ctx) => ctx.db.insert("settings", { globalEnabled: true, defaultBudgetUsd: 3000, orgTimezone: "Europe/Berlin" }));
  if (withCatalog) await t.mutation(internal.adminModels.replaceCatalog, { models: catalog, fetchedAt: 10 });
  return t;
}

// Connects the fixture project through the dashboard action with its first bot's token and the default pipeline.
async function connected() {
  const t = await setup();
  const gitlab = fakeGitlab();
  const { projectId } = await t.action(api.admin.connectProject, { ...admin, token: "glpat-first", stageModels: defaultStageModels });
  return { t, gitlab, projectId };
}

function webhook(t: Awaited<ReturnType<typeof setup>>, deliveryKey: string) {
  return t.fetch("/webhook/gitlab", { method: "POST", body: JSON.stringify(reviewerAdded),
    headers: { "X-Gitlab-Token": "hook-test", "Content-Type": "application/json", "Idempotency-Key": deliveryKey } });
}

it("rejects every project and catalog function without the admin secret before asking GitLab", async () => {
  const { t, gitlab, projectId } = await connected();
  const requests = gitlab.requests;
  for (const adminSecret of ["", "wrong", worker.workerSecret]) {
    await expect(t.query(api.admin.projects, { adminSecret })).rejects.toThrow(/unauthorized/);
    await expect(t.action(api.admin.refreshModels, { adminSecret })).rejects.toThrow(/unauthorized/);
    await expect(t.action(api.admin.connectProject, { adminSecret, token: "glpat-second" })).rejects.toThrow(/unauthorized/);
    await expect(t.action(api.admin.checkProject, { adminSecret, projectId })).rejects.toThrow(/unauthorized/);
    await expect(t.mutation(api.admin.savePipeline, { adminSecret, projectId, stageModels: changedPipeline, expectedRevision: 1 })).rejects.toThrow(/unauthorized/);
    await expect(t.mutation(api.admin.disconnectProject, { adminSecret, projectId })).rejects.toThrow(/unauthorized/);
  }
  expect(gitlab.requests).toBe(requests);
  expect(await t.run((ctx) => ctx.db.query("projectTokens").collect())).toHaveLength(1);
});

it("refuses a first connect without a catalog-valid pipeline before writing labels to GitLab", async () => {
  const t = await setup();
  const gitlab = fakeGitlab();
  await expect(t.action(api.admin.connectProject, { ...admin, token: "glpat-first" })).rejects.toThrow(/pipeline_required/);
  await expect(t.action(api.admin.connectProject, { ...admin, token: "glpat-first",
    stageModels: { ...changedPipeline, detect: { model: "new-vendor/new-model", effort: "high" } } })).rejects.toThrow(/unsupported_model_selection/);
  expect(gitlab.labels).toEqual([]);
  expect(await t.run((ctx) => ctx.db.query("projectTokens").collect())).toEqual([]);
  expect(await t.run((ctx) => ctx.db.query("projects").collect())).toEqual([]);
});

it("connects a project with its pipeline, creates its review labels, sets the bot's avatar, and stores the token sealed", async () => {
  const t = await setup();
  const gitlab = fakeGitlab();
  const createdLabels = ["fred-review::clean", "fred-review::findings"];
  expect(await t.action(api.admin.connectProject, { ...admin, token: " glpat-first\n", stageModels: changedPipeline }))
    .toEqual({ projectId: expect.any(String), path: fixtureProject.path, createdLabels, avatarSet: true });
  expect(gitlab.labels).toEqual(createdLabels);
  expect(gitlab.avatars.get(901)).toEqual(fredIcon);
  const [row] = await t.run((ctx) => ctx.db.query("projectTokens").collect());
  expect(row).toMatchObject({ name: "0 FRED", botUserId: "901", botUsername: "project_7_bot_fred", scopes: ["api"], accessLevel: 30, expiresAt: "2027-01-01" });
  expect(row?.sealedToken).not.toContain("glpat-first");
  expect(await openToken(row!.sealedToken, "7")).toBe("glpat-first");
  expect(await t.run((ctx) => ctx.db.query("projects").collect())).toMatchObject([
    { ...fixtureProject, stageModels: changedPipeline, pipelineRevision: 1, botUserIds: ["901"] },
  ]);
});

it("connects a project even when GitLab refuses the bot's avatar", async () => {
  const t = await setup();
  const gitlab = fakeGitlab();
  gitlab.avatarRefused = true;
  expect(await t.action(api.admin.connectProject, { ...admin, token: "glpat-first", stageModels: defaultStageModels }))
    .toMatchObject({ path: fixtureProject.path, avatarSet: false });
  expect(await t.query(internal.projectTokens.credential, { gitlabProjectId: "7" })).toMatchObject({ token: "glpat-first" });
});

it("reconnecting with another bot's token keeps the pipeline and remembers every bot user", async () => {
  const { t } = await connected();
  await t.action(api.admin.connectProject, { ...admin, token: "glpat-second", gitlabProjectId: "7" });
  expect(await t.run((ctx) => ctx.db.query("projects").collect())).toMatchObject([
    { stageModels: defaultStageModels, pipelineRevision: 1, botUserIds: ["901", "905"] },
  ]);
  expect(await t.run((ctx) => ctx.db.query("projectTokens").collect())).toMatchObject([{ botUserId: "905" }]);
  expect(await t.query(internal.projectTokens.credential, { gitlabProjectId: "7" }))
    .toEqual({ token: "glpat-second", botUserId: "905", botUserIds: ["901", "905"] });
});

it("refuses a replacement token that belongs to another project", async () => {
  const { t } = await connected();
  await expect(t.action(api.admin.connectProject, { ...admin, token: "glpat-other", gitlabProjectId: "7" }))
    .rejects.toThrow("This token belongs to frei/other, not to the project you are replacing.");
  expect(await t.query(internal.projectTokens.credential, { gitlabProjectId: "7" })).toMatchObject({ token: "glpat-first" });
  expect(await t.run((ctx) => ctx.db.query("projects").collect())).toHaveLength(1);
});

it("never hands out a GITLAB_URL that carries credentials", async () => {
  const { t } = await connected();
  vi.stubEnv("GITLAB_URL", "https://user:secret@gitlab.invalid/");
  expect((await t.query(api.admin.projects, admin)).gitlabUrl).toBeNull();
});

it("lists connected projects first with token health and never the token", async () => {
  const { t } = await connected();
  await t.run((ctx) => ctx.db.insert("projects", { gitlabProjectId: "3", path: "aaa/unconnected" }));
  const listed = await t.query(api.admin.projects, admin);
  expect(listed).toMatchObject({ gitlabUrl: "https://gitlab.invalid", catalog, fetchedAt: 10, projects: [
    { path: fixtureProject.path, stageModels: defaultStageModels, pipelineRevision: 1, lastReviewAt: null,
      token: { name: "0 FRED", botUserId: "901", accessLevel: 30, expiresAt: "2027-01-01", problem: null } },
    { path: "aaa/unconnected", stageModels: null, pipelineRevision: 0, token: null },
  ] });
  const [row] = await t.run((ctx) => ctx.db.query("projectTokens").collect());
  expect(JSON.stringify(listed)).not.toContain("glpat-first");
  expect(JSON.stringify(listed)).not.toContain(row!.sealedToken);
});

it("saves a pipeline at the loaded revision, and only jobs enqueued afterwards use it", async () => {
  const { t, projectId } = await connected();
  const before = await t.mutation(internal.enqueue.enqueue, { ...trigger, ...delivery() });
  if (before.result !== "queued") throw new Error("expected queued review");
  expect(await t.mutation(api.admin.savePipeline, { ...admin, projectId, stageModels: changedPipeline, expectedRevision: 1 }))
    .toEqual({ stageModels: changedPipeline, revision: 2 });
  await expect(t.mutation(api.admin.savePipeline, { ...admin, projectId, stageModels: defaultStageModels, expectedRevision: 1 })).rejects.toThrow(/pipeline_changed/);
  await expect(t.mutation(api.admin.savePipeline, { ...admin, projectId, expectedRevision: 2,
    stageModels: { ...changedPipeline, validate: { model: "unknown/model", effort: "high" } } })).rejects.toThrow(/unsupported_model_selection/);
  const after = await t.mutation(internal.enqueue.enqueue, { ...trigger, mrIid: 2, deliveryKey: "second" });
  if (after.result !== "queued") throw new Error("expected queued review");
  expect(await t.mutation(api.jobs.claim, claim)).toMatchObject({ _id: before.jobId, stageModels: defaultStageModels });
  expect((await t.run((ctx) => ctx.db.get(after.jobId)))?.stageModels).toEqual(changedPipeline);
  expect(await t.run((ctx) => ctx.db.get(projectId))).toMatchObject({ stageModels: changedPipeline, pipelineRevision: 2 });
});

it("keeps a failed publication's pipeline when it is retried after a pipeline save", async () => {
  const { t, projectId } = await connected();
  await t.mutation(internal.enqueue.enqueue, { ...trigger, ...delivery() });
  const job = await t.mutation(api.jobs.claim, claim);
  if (job?.kind !== "review") throw new Error("expected claimed review");
  const lease = { ...worker, jobId: job._id, leaseToken: job.leaseToken };
  const resultJson = JSON.stringify({ findings: [], findingDecisions: [], effects: [
    { key: "summary", kind: "summary", body: "Clean", findingIndexes: [] },
    { key: "label", kind: "label", label: "fred-review::clean", removeLabel: "fred-review::findings" },
  ] });
  await t.mutation(api.jobs.saveResult, { ...lease, resultJson });
  await t.mutation(api.jobs.fail, { ...lease, failureReason: "error" });
  await t.mutation(api.admin.savePipeline, { ...admin, projectId, stageModels: changedPipeline, expectedRevision: 1 });
  expect(await t.mutation(internal.enqueue.enqueue, { ...trigger, deliveryKey: "publication-retry" })).toEqual({ result: "queued", jobId: job._id });
  expect(await t.run((ctx) => ctx.db.get(job._id))).toMatchObject({ resultJson, stageModels: defaultStageModels });
});

it("keeps a saved pipeline when a refresh removes its model and rejects only new saves", async () => {
  const { t, projectId } = await connected();
  await t.mutation(api.admin.savePipeline, { ...admin, projectId, stageModels: changedPipeline, expectedRevision: 1 });
  await t.mutation(internal.adminModels.replaceCatalog, { models: catalog.filter((model) => model.id !== "new-vendor/new-model"), fetchedAt: 20 });
  expect((await t.query(api.admin.projects, admin)).projects).toMatchObject([{ stageModels: changedPipeline, pipelineRevision: 2 }]);
  await expect(t.mutation(api.admin.savePipeline, { ...admin, projectId, stageModels: changedPipeline, expectedRevision: 2 })).rejects.toThrow(/unsupported_model_selection/);
});

it("requires a catalog before saving a pipeline and lists an empty catalog", async () => {
  const t = await setup(false);
  const projectId = await t.run((ctx) => ctx.db.insert("projects", fixtureProject));
  expect(await t.query(api.admin.projects, admin)).toMatchObject({ catalog: [], fetchedAt: null });
  await expect(t.mutation(api.admin.savePipeline, { ...admin, projectId, stageModels: changedPipeline, expectedRevision: 0 })).rejects.toThrow(/model_catalog_unavailable/);
});

it("disconnecting stops new reviews and fails queued ones at claim until the project is connected again", async () => {
  const { t, projectId } = await connected();
  await t.action(api.admin.connectProject, { ...admin, token: "glpat-other", stageModels: defaultStageModels });
  expect(await (await webhook(t, "queued")).json()).toMatchObject({ provider: "fred", result: "queued" });
  const queued = (await t.run((ctx) => ctx.db.query("reviewJobs").unique()))!;
  await t.mutation(internal.enqueue.enqueue, { ...delivery(), ...trigger, project: { gitlabProjectId: "8", path: otherProject.path_with_namespace } });

  await t.mutation(api.admin.disconnectProject, { ...admin, projectId });
  expect(await (await webhook(t, "disconnected")).json()).toEqual({ ignored: true, reason: "project not connected to FRED" });
  expect(await t.mutation(api.jobs.claim, claim)).toMatchObject({ gitlabProjectId: "8", gitlabToken: "glpat-other" });
  expect(await t.run((ctx) => ctx.db.get(queued._id))).toMatchObject({ status: "failed", failureReason: "error", denialReason: unconnectedProject });
  expect(await t.mutation(api.jobs.claim, claim)).toBeNull();

  await t.action(api.admin.connectProject, { ...admin, token: "glpat-first", gitlabProjectId: "7" });
  expect(await (await webhook(t, "reconnected")).json()).toMatchObject({ provider: "fred", result: "queued" });
  expect(await t.mutation(api.jobs.claim, claim)).toMatchObject({ gitlabProjectId: "7", gitlabToken: "glpat-first", stageModels: defaultStageModels });
});

it("records a failed token check as the project's problem and clears it on the next passing check", async () => {
  const { t, gitlab, projectId } = await connected();
  gitlab.unauthorized = true;
  vi.setSystemTime(1_000_000);
  const problem = "GitLab rejected the token. It is revoked, expired, or mistyped.";
  expect(await t.action(api.admin.checkProject, { ...admin, projectId })).toEqual({ problem });
  expect(await t.run((ctx) => ctx.db.query("projectTokens").unique())).toMatchObject({ problem, checkedAt: 1_000_000, expiresAt: "2027-01-01" });

  gitlab.unauthorized = false;
  gitlab.expiresAt = "2027-06-01";
  vi.setSystemTime(2_000_000);
  expect(await t.action(api.admin.checkProject, { ...admin, projectId })).toEqual({ problem: null });
  const row = await t.run((ctx) => ctx.db.query("projectTokens").unique());
  expect(row).toMatchObject({ checkedAt: 2_000_000, expiresAt: "2027-06-01" });
  expect(row).not.toHaveProperty("problem");
});

it("rejects empty refreshes and ignores stale catalog responses", async () => {
  const t = await setup();
  await expect(t.mutation(internal.adminModels.replaceCatalog, { models: [], fetchedAt: 20 })).rejects.toThrow(/model_catalog_empty/);
  await t.mutation(internal.adminModels.replaceCatalog, { models: catalog.slice(0, 1), fetchedAt: 5 });
  expect(await t.query(api.admin.projects, admin)).toMatchObject({ catalog, fetchedAt: 10 });
});

const apiModel = {
  id: "new-vendor/catalog-model", name: "Discovered model", canonical_slug: "new-vendor/catalog-model", created: 0,
  context_length: 100_000, architecture: { modality: "text->text", input_modalities: ["text"], output_modalities: ["text"] },
  top_provider: { is_moderated: false, max_completion_tokens: 10_000 }, supported_parameters: ["tools", "reasoning"],
  pricing: { prompt: "0", completion: "0" }, default_parameters: null, per_request_limits: null,
  supported_voices: null, links: { details: "/api/v1/models/new-vendor/catalog-model/endpoints" },
  reasoning: { mandatory: true, supported_efforts: ["max", "high", "none"], default_effort: "high" },
};

it("refreshes every SDK catalog page without a token and keeps per-model effort metadata", async () => {
  const t = await setup();
  const requests: Request[] = [];
  vi.stubEnv("OPENROUTER_BASE_URL", "https://untrusted.example/api");
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const request = new Request(input);
    requests.push(request);
    const data = requests.length === 1
      ? Array.from({ length: 500 }, (_, index) => ({ ...apiModel, id: `vendor/unsupported-${index}`, supported_parameters: [] }))
      : [apiModel];
    return new Response(JSON.stringify({ data, links: { next: null }, total_count: 501 }), { headers: { "Content-Type": "application/json" } });
  });
  expect(await t.action(api.admin.refreshModels, admin)).toMatchObject({ count: 1 });
  expect(requests).toHaveLength(2);
  expect(new URL(requests[1]!.url).searchParams.get("offset")).toBe("500");
  for (const request of requests) {
    expect(new URL(request.url).origin).toBe("https://openrouter.ai");
    expect(request.headers.has("Authorization")).toBe(false);
  }
  expect(await t.query(api.admin.projects, admin)).toMatchObject({
    catalog: [{ id: apiModel.id, efforts: ["default", "high", "max"], defaultEffort: "high", reasoningMandatory: true }],
  });
});

it("keeps the last catalog when the SDK cannot read the refresh response", async () => {
  const t = await setup();
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ data: [{ id: "broken-model" }] }), { headers: { "Content-Type": "application/json" } }));
  await expect(t.action(api.admin.refreshModels, admin)).rejects.toThrow(/model_catalog_refresh_failed/);
  expect(await t.query(api.admin.projects, admin)).toMatchObject({ catalog, fetchedAt: 10 });
});
