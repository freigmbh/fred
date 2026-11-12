import { v } from "convex/values";
import { defaultStageModels, stageModels } from "@fred/contracts";
import { internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { dayOf, monthOf } from "./month";
import { recordOutcome } from "./reviewOutcomes";
import { sealToken } from "./tokenVault";
import { rollUpUsage } from "./usageRollups";

function requireDevelopment() {
  if (process.env.FRED_DEV_ONLY !== "1") throw new Error("Expected isolated local development backend");
}

export const seed = internalMutation({
  args: {},
  handler: async (ctx) => {
    requireDevelopment();
    if (!await ctx.db.query("settings").first()) {
      await ctx.db.insert("settings", { globalEnabled: true, defaultBudgetUsd: 3000, orgTimezone: "Europe/Berlin" });
    }
  },
});

// Deterministic pseudo-random amounts so the sample dashboard looks the same on every instance.
function amounts(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

// Fills the admin UI with a month of sample reviews, usage, and failures on a project verification never touches. Runs once.
async function fillDashboard(ctx: MutationCtx) {
  if (await ctx.db.query("projects").withIndex("by_path", (q) => q.eq("path", "fixtures/sample")).first()) return;
  const settings = await ctx.db.query("settings").first();
  const timezone = settings?.orgTimezone ?? "Europe/Berlin";
  const random = amounts(7);
  const dayMs = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const projectId = await ctx.db.insert("projects", { gitlabProjectId: "1001", path: "fixtures/sample" });
  const developers = await Promise.all([
    ctx.db.insert("developers", { gitlabUserId: "1040", username: "sample-a" }),
    ctx.db.insert("developers", { gitlabUserId: "1041", username: "sample-b" }),
    ctx.db.insert("developers", { gitlabUserId: "1042", blocked: true, blockedReason: "sample block" }),
  ]);
  await ctx.db.insert("budgets", { developerId: developers[1], monthlyUsd: 50 });
  // Every lab in the catalog, so the spend page's per-lab views fill up. Jobs cycle through the lists in order, so even a
  // month that has just begun shows a lab per day and provider.
  const models = {
    claude: ["anthropic/claude-fable-5.1", "google/gemini-3.1-pro", "x-ai/grok-5", "deepseek/deepseek-v4", "qwen/qwen3.5-coder", "z-ai/glm-5", "minimax/minimax-m3", "anthropic/claude-opus-5"],
    codex: ["openai/gpt-6-astra", "moonshotai/kimi-k3", "meta-llama/llama-5-405b", "mistralai/mistral-large-3", "perplexity/sonar-pro", "nvidia/nemotron-ultra", "google/gemini-3.1-pro", "openai/gpt-5.4"],
  };
  let mrIid = 100;
  for (let daysAgo = 29; daysAgo >= 0; daysAgo--) {
    const at = now - daysAgo * dayMs;
    if (new Date(at).getUTCDay() === 0 && random() < 0.7) continue;
    for (const p of ["claude", "codex"] as const) {
      const developerId = developers[Math.floor(random() * developers.length)]!;
      const failed = random() < 0.12;
      const claimedAt = at + 20_000;
      const completedAt = claimedAt + 240_000 + Math.floor(random() * 900_000);
      const clean = random() < 0.55;
      const model = models[p][mrIid % models[p].length] ?? defaultStageModels.detect.model;
      const label = `${p}-review::${clean ? "clean" : "findings"}`;
      const jobId = await ctx.db.insert("reviewJobs", {
        projectId, mrIid: ++mrIid, headSha: "b".repeat(40), provider: p, developerId, triggeredBy: "1040",
        status: failed ? "failed" : "done", claimedAt, completedAt, leaseGeneration: 1,
        ...(failed ? { failureReason: "timeout" as const, denialReason: "The operation exceeded its deadline" } : {
          resultJson: JSON.stringify({ findings: [], resolvedFindingIds: [], effects: [
            { key: "summary", kind: "summary", body: "sample", findingIndexes: [] },
            { key: "label", kind: "label", label, removeLabel: `${p}-review::${clean ? "findings" : "clean"}` },
          ] }),
        }),
      });
      if (!failed && !clean) {
        for (const severity of ["blocking", "should_fix", "nit"] as const) {
          if (random() < 0.5) await ctx.db.insert("findings", { jobId, projectId, mrIid, provider: p, file: "src/sample.ts", line: 1, severity, title: "sample", body: "sample", status: random() < 0.2 ? "rejected" : "posted" });
        }
      }
      if (!failed) {
        const job = await ctx.db.get(jobId);
        if (job) await recordOutcome(ctx, job, completedAt);
      }
      for (const stage of ["detect", "validate"] as const) {
        const inputTokens = Math.floor(200_000 + random() * 900_000);
        const row = {
          provider: p, model, stage, eventKey: `${stage}:${jobId}`,
          inputTokens, cachedInputTokens: Math.floor(inputTokens * 8), outputTokens: Math.floor(5_000 + random() * 20_000),
          costUsd: Number((1 + random() * (p === "claude" ? 24 : 8)).toFixed(4)), priceTableVersion: "sample",
          month: monthOf(at, timezone), day: dayOf(at, timezone),
        };
        await ctx.db.insert("usageEvents", { ...row, jobId, developerId, rolledUp: true });
        // The spend page reads the rollups, so the sample ledger rows fold into them the way recordUsage does.
        const job = await ctx.db.get(jobId);
        if (job) await rollUpUsage(ctx, job, row);
      }
      if (failed) {
        await ctx.db.insert("reviewFailures", { jobId, leaseGeneration: 1, projectId, mrIid, provider: p, developerId, triggeredBy: "1040",
          kind: "failed", reason: "timeout", summary: "The operation exceeded its deadline", failureCategory: "timeout", at: completedAt });
      }
    }
  }
  await ctx.db.insert("reviewFailures", { projectId, mrIid: ++mrIid, provider: "claude", developerId: developers[2], triggeredBy: "1042",
    kind: "denied", reason: "developer_blocked", summary: "blocked, sample block", at: now - 2 * dayMs });
  await ctx.db.insert("reviewFailures", { projectId, mrIid: ++mrIid, provider: "codex", developerId: developers[1], triggeredBy: "1041",
    kind: "denied", reason: "budget_exhausted", summary: "budget reached, 50.00 USD of 50.00 USD", at: now - dayMs });
}

export const seedDashboard = internalMutation({
  args: {},
  handler: async (ctx) => {
    requireDevelopment();
    await fillDashboard(ctx);
  },
});

// Bot user and token of the fixture project.
const fixtureBot = { botUserId: "3", token: "local-fixture" };

// Connects the fixture project like the dashboard does, without asking GitLab. Rerunning replaces the token.
export const connectFixture = internalMutation({
  args: {},
  handler: async (ctx) => {
    requireDevelopment();
    const existing = await ctx.db.query("projects").withIndex("by_gitlab_project", (q) => q.eq("gitlabProjectId", "1")).unique();
    const projectId = existing?._id ?? await ctx.db.insert("projects", { gitlabProjectId: "1", path: "fixtures/example" });
    await ctx.db.patch(projectId, { stageModels: existing?.stageModels ?? defaultStageModels, botUserIds: [fixtureBot.botUserId] });
    const row = await ctx.db.query("projectTokens").withIndex("by_project", (q) => q.eq("projectId", projectId)).unique();
    if (row) await ctx.db.delete(row._id);
    await ctx.db.insert("projectTokens", { projectId, sealedToken: await sealToken(fixtureBot.token, "1"), tokenId: 1, name: "0 FRED", scopes: ["api"], expiresAt: null,
      botUserId: fixtureBot.botUserId, botUsername: "project_1_bot_fixture", accessLevel: 30, checkedAt: Date.now() });
  },
});

export const enqueue = internalMutation({
  args: { runId: v.string(), model: v.optional(v.string()), effort: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireDevelopment();
    const project = await ctx.db.query("projects").withIndex("by_gitlab_project", (q) => q.eq("gitlabProjectId", "1")).unique();
    if (!project) throw new Error("Run dev:connectFixture before enqueueing");
    const projectId = project._id;
    const developer = await ctx.db.query("developers").withIndex("by_gitlab_user", (q) => q.eq("gitlabUserId", "2")).unique();
    const developerId = developer?._id ?? await ctx.db.insert("developers", { gitlabUserId: "2", username: "local-fixture" });
    const jobs = await ctx.db.query("reviewJobs").collect();
    const mrIid = jobs.reduce((highest, job) => Math.max(highest, job.mrIid), 0) + 1;
    const defaults = project.stageModels ?? defaultStageModels;
    const selection = (stage: "detect" | "validate") => ({
      model: args.model ?? defaults[stage].model,
      effort: args.effort ?? (args.model ? "default" : defaults[stage].effort),
    });
    const selections = stageModels.parse({ detect: selection("detect"), validate: selection("validate") });
    return ctx.db.insert("reviewJobs", { projectId, developerId, mrIid, headSha: "a".repeat(40),
      provider: "fred", stageModels: selections, ...(project.collectTranscripts ? { collectTranscripts: true } : {}),
      status: "queued", triggeredBy: "local-fixture", deliveryKey: args.runId });
  },
});

export const state = internalQuery({
  args: {},
  handler: async (ctx) => {
    requireDevelopment();
    const sample = await ctx.db.query("projects").withIndex("by_path", (q) => q.eq("path", "fixtures/sample")).first();
    const jobs = (await ctx.db.query("reviewJobs").collect()).filter((job) => job.projectId !== sample?._id);
    const jobIds = new Set(jobs.map((job) => job._id));
    return {
      jobs, findings: (await ctx.db.query("findings").collect()).filter((finding) => jobIds.has(finding.jobId)),
      usage: (await ctx.db.query("usageEvents").collect()).filter((usage) => jobIds.has(usage.jobId)), notes: await ctx.db.query("mrNotes").collect(),
      diagnostics: await ctx.db.query("diagnosticEvents").collect(), snapshots: await ctx.db.query("diagnosticSnapshots").collect(),
    };
  },
});
