import { denialGate, finishedStatuses, inFlightStatuses, retiredProviders, type DenialGate } from "@fred/contracts";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";
import { adminAuth, requireAdmin } from "./adminAuth";
import { jobSnapshot, readSnapshot } from "./diagnosticCapture";
import { gitlabWebUrl } from "./gitlabConfig";
import { jobsWithStatus } from "./jobLifecycle";
import { dayOf, daysOfMonth, monthOf, workingDays } from "./month";
import { noteKeys } from "./noteKeys";
import { findingCounts, savedResult, verdictOf } from "./reviewOutcomes";
import { failureKind, provider as providerArg } from "./schema";
import { loadSettings, maintenanceMode } from "./settings";
import { type Amounts, sumAmounts, usdOf } from "./usageRollups";
import { literals } from "./validators";

export { exportManifest, exportPage } from "./dataExport";
export { checkProject, connectProject, disconnectProject, projects, savePipeline } from "./adminProjects";
export { refreshModels } from "./openrouterCatalog";
export { downloadTranscript, setTranscriptCollection } from "./transcripts";

type Job = Doc<"reviewJobs">;
type Daily = Doc<"usageDaily">;
type Provider = Job["provider"];

const providers = ["fred", ...retiredProviders] as const satisfies readonly Provider[];
const dayMs = 24 * 60 * 60 * 1000;
const failurePageLimit = 100;

function percentile(values: number[], fraction: number) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? null;
}

type Outcome = Doc<"reviewOutcomes">;

function isDenialGate(reason: string): reason is DenialGate {
  return denialGate.safeParse(reason).success;
}

// A budget owner as admin rows show one, or null for a missing developer.
function developerSummary(developer: Doc<"developers"> | null) {
  return developer ? { gitlabUserId: developer.gitlabUserId, username: developer.username ?? null, displayName: developer.displayName ?? null } : null;
}

// Median and worst claim wait and run time over outcome rows. Rows of jobs never claimed carry neither.
function latencyOf(rows: Outcome[]) {
  const waits = rows.flatMap((row) => row.claimWaitMs === undefined ? [] : [row.claimWaitMs]);
  const runs = rows.flatMap((row) => row.runMs === undefined ? [] : [row.runMs]);
  return { claimP50Ms: percentile(waits, 0.5), claimMaxMs: percentile(waits, 1), runP50Ms: percentile(runs, 0.5), runMaxMs: percentile(runs, 1) };
}

function outcomesFor(provider: Provider, rows: Outcome[]) {
  const own = rows.filter((row) => row.provider === provider);
  const findings = { blocking: 0, should_fix: 0, nit: 0 };
  let validatorRejected = 0;
  for (const row of own) {
    findings.blocking += row.findings.blocking;
    findings.should_fix += row.findings.should_fix;
    findings.nit += row.findings.nit;
    validatorRejected += row.validatorRejected;
  }
  return {
    provider, done: own.length, clean: own.filter((row) => row.clean).length, findings,
    findingsTotal: findings.blocking + findings.should_fix + findings.nit + validatorRejected, validatorRejected, latency: latencyOf(own),
  };
}

// Queue health, policy flags, the last seven days of failures, and this month's review outcomes per provider.
export const overview = query({
  args: adminAuth,
  handler: async (ctx, args) => {
    requireAdmin(args.adminSecret);
    const now = Date.now();
    const settings = await loadSettings(ctx);
    const month = monthOf(now, settings.orgTimezone);
    const [queued, running, publishing] = await Promise.all([jobsWithStatus(ctx, "queued"), jobsWithStatus(ctx, "running"), jobsWithStatus(ctx, "publishing")]);
    const recentFailures = await ctx.db.query("reviewFailures").withIndex("by_at", (q) => q.gte("at", now - 7 * dayMs)).collect();
    const done = (await ctx.db.query("reviewOutcomes").withIndex("by_completed", (q) => q.gte("completedAt", now - 32 * dayMs)).collect())
      .filter((row) => monthOf(row.completedAt, settings.orgTimezone) === month);
    const deniedAtEnqueue = Object.fromEntries(denialGate.options.map((gate) => [gate, 0])) as Record<DenialGate, number>;
    let failed = 0;
    let denied = 0;
    let noteFailed = 0;
    for (const failure of recentFailures) {
      if (failure.kind === "failed") failed++;
      else if (failure.kind === "note_failed") noteFailed++;
      else if (failure.jobId !== undefined) denied++;
      else if (isDenialGate(failure.reason)) deniedAtEnqueue[failure.reason]++;
    }
    return {
      now, month,
      queue: { queued: queued.length, running: running.length, publishing: publishing.length,
        oldestQueuedAt: queued.length ? Math.min(...queued.map((job) => job._creationTime)) : null },
      flags: { globalEnabled: settings.globalEnabled, maintenanceMode: maintenanceMode() },
      last7Days: { failed, denied, noteFailed, deniedAtEnqueue },
      outcomes: providers.map((provider) => outcomesFor(provider, done)),
    };
  },
});

// Spend so far of one job, from its ledger rows. Jobs have few rows, so no rollup is kept per job.
async function usageOfJob(ctx: QueryCtx, jobId: Id<"reviewJobs">) {
  const rows = await ctx.db.query("usageEvents").withIndex("by_job", (q) => q.eq("jobId", jobId)).collect();
  return rows.reduce((sum, row) => sum + row.costUsd, 0);
}

// The compact snapshot a failure comment carries survives job recovery, so it is the durable detail source.
async function failureDetail(ctx: QueryCtx, failure: Doc<"reviewFailures">, job: Job | null) {
  if (!job) return null;
  const note = failure.noteId ? await ctx.db.get(failure.noteId) : failure.kind === "failed"
    ? await ctx.db.query("mrNotes").withIndex("by_key", (q) => q.eq("key", noteKeys.jobFailure(job._id, failure.leaseGeneration ?? 0))).unique()
    : null;
  const snapshot = readSnapshot(note?.failureJson) ?? (failure.kind === "note_failed" ? undefined : readSnapshot(job.diagnosticJson));
  return {
    headSha: job.headSha, status: job.status, workerId: failure.leaseGeneration === job.leaseGeneration ? job.workerId ?? null : null, leaseGeneration: failure.leaseGeneration ?? null,
    usageIncomplete: job.usageIncomplete ?? false, usageConfirmedStages: job.usageConfirmedStages ?? [],
    phase: snapshot?.phase ?? null, model: snapshot?.model ?? null, effort: snapshot?.effort ?? null, failure: snapshot?.failure ?? null,
    stageModels: job.stageModels ?? null,
    noteStatus: note?.status ?? null,
  };
}

// Newest failures with diagnostic detail and the GitLab base URL. Pass nextCursor to continue a page.
export const failures = query({
  args: { ...adminAuth, since: v.optional(v.number()), before: v.optional(v.number()), kind: v.optional(failureKind), limit: v.optional(v.number()), cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireAdmin(args.adminSecret);
    const limit = Math.max(1, Math.min(Math.floor(args.limit ?? 50), failurePageLimit));
    const kind = args.kind;
    const scope = kind === undefined
      ? ctx.db.query("reviewFailures").withIndex("by_at", (q) => q.gte("at", args.since ?? 0).lt("at", args.before ?? Number.MAX_SAFE_INTEGER))
      : ctx.db.query("reviewFailures").withIndex("by_kind_at", (q) => q.eq("kind", kind).gte("at", args.since ?? 0).lt("at", args.before ?? Number.MAX_SAFE_INTEGER));
    const page = await scope.order("desc").paginate({ numItems: limit, cursor: args.cursor ?? null });
    const rows = await Promise.all(page.page.map(async (failure) => {
      const [project, developer, job] = await Promise.all([
        ctx.db.get(failure.projectId),
        failure.developerId ? ctx.db.get(failure.developerId) : null,
        failure.jobId ? ctx.db.get(failure.jobId) : null,
      ]);
      return {
        _id: failure._id, at: failure.at, kind: failure.kind, reason: failure.reason, summary: failure.summary,
        failureCategory: failure.failureCategory ?? null, providerCode: failure.providerCode ?? null,
        provider: failure.provider, mrIid: failure.mrIid, jobId: failure.jobId ?? null, triggeredBy: failure.triggeredBy ?? null,
        project: project ? { path: project.path, gitlabProjectId: project.gitlabProjectId } : null,
        developer: developerSummary(developer),
        costUsd: failure.jobId ? await usageOfJob(ctx, failure.jobId) : 0,
        detail: await failureDetail(ctx, failure, job),
      };
    }));
    return { rows, hasMore: !page.isDone, nextCursor: page.isDone ? null : page.continueCursor, gitlabUrl: gitlabWebUrl() };
  },
});

// Findings the saved result will post or has posted, by severity.
async function publishedFindings(ctx: QueryCtx, job: Job) {
  const { blocking, should_fix, nit } = await findingCounts(ctx, job._id);
  return { blocking, should_fix, nit };
}

async function queueRow(ctx: QueryCtx, job: Job) {
  const [project, developer, snapshot, costUsd, findings] = await Promise.all([
    ctx.db.get(job.projectId), ctx.db.get(job.developerId), jobSnapshot(ctx, job), usageOfJob(ctx, job._id),
    job.status === "publishing" ? publishedFindings(ctx, job) : null,
  ]);
  return {
    jobId: job._id, status: job.status, provider: job.provider, mrIid: job.mrIid, headSha: job.headSha,
    previousReviewedSha: job.previousReviewedSha ?? null,
    project: project ? { path: project.path } : null,
    developer: developerSummary(developer),
    createdAt: job._creationTime, claimedAt: job.claimedAt ?? null,
    workerId: job.workerId ?? null, leaseGeneration: job.leaseGeneration ?? 0, leaseExpiresAt: job.leaseExpiresAt ?? null,
    phase: snapshot?.phase ?? null, lastActivityAt: snapshot?.lastActivityAt ?? null, model: snapshot?.model ?? null,
    publication: { acknowledged: job.publicationAcks?.length ?? 0, total: savedResult(job)?.effects.length ?? null },
    findings, costUsd,
  };
}

// Every job in flight, grouped queued, running, publishing and oldest first inside each stage, with worker phase, lease state, publication progress, and spend so far.
export const queue = query({
  args: adminAuth,
  handler: async (ctx, args) => {
    requireAdmin(args.adminSecret);
    const age = (job: Job) => job.status === "queued" ? job._creationTime : job.claimedAt ?? job._creationTime;
    const jobs = (await Promise.all(inFlightStatuses.map((status) => jobsWithStatus(ctx, status)))).flatMap((stage) => stage.sort((a, b) => age(a) - age(b)));
    return { now: Date.now(), gitlabUrl: gitlabWebUrl(), rows: await Promise.all(jobs.map((job) => queueRow(ctx, job))) };
  },
});

const finishedStatus = literals(finishedStatuses);
type FinishedStatus = (typeof finishedStatuses)[number];
const reviewPageLimit = 200;

// When a finished job ended: its completion time, or its creation time for a denial at claim, which never completes.
const endedAt = (job: Job) => job.completedAt ?? job._creationTime;

// Every model that touched a job: the stage selections fixed at enqueue and the models the ledger reports, without alias prefixes.
function modelsOf(job: Job, usage: Doc<"usageEvents">[]) {
  const selections = job.stageModels ? [job.stageModels.detect, job.stageModels.validate] : [];
  return [...new Set([...selections, ...usage].map(modelIdOf))];
}

// Both newest-first reads of one finished status ended at or after `since`. Denials at claim and queued jobs superseded by a
// push never set completedAt and sit outside any completedAt range, so the second read takes the rows without one by creation time.
function finishedReads(ctx: QueryCtx, status: FinishedStatus, since: number) {
  return {
    completed: ctx.db.query("reviewJobs").withIndex("by_status_completed", (q) => q.eq("status", status).gte("completedAt", since)).order("desc"),
    uncompleted: ctx.db.query("reviewJobs").withIndex("by_status_completed", (q) => q.eq("status", status).eq("completedAt", undefined).gte("_creationTime", since)).order("desc"),
  };
}

// Newest jobs of one finished status in the window. `capped` means a read filled its limit, so older rows exist beyond the scan.
async function finishedJobs(ctx: QueryCtx, status: FinishedStatus, since: number, limit: number) {
  const reads = finishedReads(ctx, status, since);
  const [completed, uncompleted] = await Promise.all([reads.completed.take(limit), reads.uncompleted.take(limit)]);
  return { jobs: [...completed, ...uncompleted], capped: completed.length === limit || uncompleted.length === limit };
}

async function reviewRow(ctx: QueryCtx, job: Job, usage: Doc<"usageEvents">[], models: string[]) {
  const [project, developer, findings] = await Promise.all([ctx.db.get(job.projectId), ctx.db.get(job.developerId), findingCounts(ctx, job._id)]);
  return {
    jobId: job._id, status: job.status, provider: job.provider, mrIid: job.mrIid, headSha: job.headSha, previousReviewedSha: job.previousReviewedSha ?? null,
    project: project ? { path: project.path } : null,
    developer: developerSummary(developer),
    triggeredBy: job.triggeredBy, createdAt: job._creationTime, claimedAt: job.claimedAt ?? null, endedAt: endedAt(job),
    stageModels: job.stageModels ?? null, models,
    verdict: verdictOf(job), findings,
    failureReason: job.failureReason ?? null, reason: job.denialReason ?? null,
    costUsd: usage.reduce((sum, row) => sum + row.costUsd, 0), usageIncomplete: job.usageIncomplete ?? false,
    workerId: job.workerId ?? null, leaseGeneration: job.leaseGeneration ?? 0, fredVersion: job.fredVersion ?? null,
  };
}

// Finished reviews newest first, filtered by status, provider, model, and window. Each row joins project, budget owner, the verdict,
// finding counts, every model that touched the job, and spend. `models` lists the models seen in the scanned window before the model
// filter applies, for the filter itself. A call scans at most `limit` jobs per status and completion state, so `hasMore` also covers
// rows beyond the scan.
export const reviews = query({
  args: { ...adminAuth, since: v.optional(v.number()), statuses: v.optional(v.array(finishedStatus)), provider: v.optional(providerArg),
    models: v.optional(v.array(v.string())), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    requireAdmin(args.adminSecret);
    const limit = Math.max(1, Math.min(Math.floor(args.limit ?? 50), reviewPageLimit));
    const since = args.since ?? 0;
    const statuses = args.statuses?.length ? args.statuses : finishedStatuses;
    const scans = await Promise.all(statuses.map((status) => finishedJobs(ctx, status, since, limit)));
    const scanned = scans.flatMap((scan) => scan.jobs)
      .filter((job) => args.provider === undefined || job.provider === args.provider)
      .sort((a, b) => endedAt(b) - endedAt(a));
    const withUsage = await Promise.all(scanned.map(async (job) => {
      const usage = await ctx.db.query("usageEvents").withIndex("by_job", (q) => q.eq("jobId", job._id)).collect();
      return { job, usage, models: modelsOf(job, usage) };
    }));
    const wanted = new Set(args.models ?? []);
    const matching = wanted.size ? withUsage.filter((entry) => entry.models.some((model) => wanted.has(model))) : withUsage;
    const rows = await Promise.all(matching.slice(0, limit).map(({ job, usage, models }) => reviewRow(ctx, job, usage, models)));
    return {
      now: Date.now(), gitlabUrl: gitlabWebUrl(), rows,
      models: [...new Set(withUsage.flatMap((entry) => entry.models))].sort(),
      hasMore: matching.length > limit || scans.some((scan) => scan.capped),
    };
  },
});

// Totals over every finished job admin.reviews would list for the window, statuses, and provider, without its limit, so the
// numbers never depend on how many rows the page loaded. Done jobs come from their reviewOutcomes rows instead of the jobs, their
// saved results, and their findings; spend joins each job's ledger rows. The model filter and the search box narrow only the table.
export const reviewStats = query({
  args: { ...adminAuth, since: v.optional(v.number()), statuses: v.optional(v.array(finishedStatus)), provider: v.optional(providerArg) },
  handler: async (ctx, args) => {
    requireAdmin(args.adminSecret);
    const since = args.since ?? 0;
    const statuses = args.statuses?.length ? args.statuses : finishedStatuses;
    const ownProvider = (row: { provider: Provider }) => args.provider === undefined || row.provider === args.provider;
    const outcomes = statuses.includes("done")
      ? (await ctx.db.query("reviewOutcomes").withIndex("by_completed", (q) => q.gte("completedAt", since)).collect()).filter(ownProvider)
      : [];
    const others = (await Promise.all(statuses.filter((status) => status !== "done").map(async (status) => {
      const reads = finishedReads(ctx, status, since);
      return (await Promise.all([reads.completed.collect(), reads.uncompleted.collect()])).flat();
    }))).flat().filter(ownProvider);
    const jobIds = [...outcomes.map((row) => row.jobId), ...others.map((job) => job._id)];
    const costs = await Promise.all(jobIds.map((jobId) => usageOfJob(ctx, jobId)));
    return {
      reviews: jobIds.length, done: outcomes.length, failed: others.filter((job) => job.status === "failed").length,
      clean: outcomes.filter((row) => row.clean).length,
      findings: outcomes.reduce((sum, row) => sum + row.findings.blocking + row.findings.should_fix + row.findings.nit, 0),
      runP50Ms: latencyOf(outcomes).runP50Ms,
      costUsd: costs.reduce((sum, cost) => sum + cost, 0),
    };
  },
});

// One job in full for the expanded review row: the published summary, every stored finding, the ledger rows per stage,
// the merged diagnostic snapshot's phase and failure, and the job's transcripts without storage IDs. Null for an unknown job.
export const review = query({
  args: { ...adminAuth, jobId: v.id("reviewJobs") },
  handler: async (ctx, args) => {
    requireAdmin(args.adminSecret);
    const job = await ctx.db.get(args.jobId);
    if (!job) return null;
    const [findings, usage, snapshot, transcripts] = await Promise.all([
      ctx.db.query("findings").withIndex("by_job", (q) => q.eq("jobId", job._id)).collect(),
      ctx.db.query("usageEvents").withIndex("by_job", (q) => q.eq("jobId", job._id)).collect(),
      jobSnapshot(ctx, job),
      ctx.db.query("transcripts").withIndex("by_job", (q) => q.eq("jobId", job._id)).collect(),
    ]);
    const result = savedResult(job);
    const summary = result?.effects.find((effect) => effect.kind === "summary");
    return {
      summary: summary?.kind === "summary" ? summary.body : null,
      findings: findings.map(({ _id, severity, status, file, line, oldLine, title, body, rejectReason, disposition }) =>
        ({ _id, severity, status, file, line: line ?? null, oldLine: oldLine ?? null, title, body, rejectReason: rejectReason ?? null, disposition: disposition ?? null })),
      usage: usage.map((row) => ({ stage: row.stage, model: modelIdOf(row), inputTokens: row.inputTokens, cachedInputTokens: row.cachedInputTokens,
        outputTokens: row.outputTokens, costUsd: row.costUsd, incomplete: row.incomplete ?? false })),
      usageIncompleteReason: job.usageIncompleteReason ?? null, usageConfirmedStages: job.usageConfirmedStages ?? [],
      phase: snapshot?.phase ?? null, failure: snapshot?.failure ?? null,
      publication: { acknowledged: job.publicationAcks?.length ?? 0, total: result?.effects.length ?? null },
      collectTranscripts: job.collectTranscripts ?? false,
      transcripts: transcripts.map(({ _id, stage, leaseGeneration, outcome, model, effort, bytes, turns, toolCalls, durationMs, recordedAt, storageId, omitted }) =>
        ({ _id, stage, leaseGeneration, outcome, model, effort, bytes, turns, toolCalls, durationMs, recordedAt, available: storageId !== undefined, omitted: omitted ?? null })),
    };
  },
});

// Rollup totals in the shape the spend page renders: dollars, reviews that started spending in the range, token strip.
function totalsOf(rows: Amounts[]) {
  const sum = sumAmounts(rows);
  return { costUsd: usdOf(sum.costMicroUsd), reviews: sum.reviews, tokens: { inputTokens: sum.inputTokens, cachedInputTokens: sum.cachedInputTokens, outputTokens: sum.outputTokens } };
}

function groupBy<Row, Key>(rows: Row[], keyOf: (row: Row) => Key) {
  const groups = new Map<Key, Row[]>();
  for (const row of rows) groups.set(keyOf(row), [...(groups.get(keyOf(row)) ?? []), row]);
  return groups;
}

// The model ID without OpenRouter's ~ alias prefix, so a selection recorded as ~vendor/model and as vendor/model is one model.
function modelIdOf(row: Pick<Daily, "model">) {
  return row.model.replace(/^~/, "");
}

// The model author of an OpenRouter ID such as anthropic/claude-fable-5.1. Rows from before OpenRouter take it from the bot identity.
function labOf(row: Pick<Daily, "provider" | "model">) {
  const model = modelIdOf(row);
  const slash = model.indexOf("/");
  if (slash > 0) return model.slice(0, slash);
  return row.provider === "claude" ? "anthropic" : "openai";
}

// Cost, reviews, and tokens per lab, largest spend first.
function labTotals(rows: Daily[]) {
  return [...groupBy(rows, labOf)].map(([lab, own]) => ({ lab, ...totalsOf(own) })).sort((a, b) => b.costUsd - a.costUsd);
}

// Cost and tokens per model across every bot, largest spend first.
function modelTotals(rows: Daily[]) {
  return [...groupBy(rows, modelIdOf).values()].flatMap((own) => {
    const first = own[0];
    if (!first) return [];
    const { costUsd, tokens } = totalsOf(own);
    return [{ lab: labOf(first), model: modelIdOf(first), costUsd, tokens }];
  }).sort((a, b) => b.costUsd - a.costUsd);
}

// Flagged jobs that belong to the month: created in the org-local month, or first spent in it per firstUsageDay, so a job
// claimed before midnight whose usage lands in the month counts in both. One by_usage_incomplete read over the UTC month
// padded by two days each side, never one read per job; a job that waited in the queue for more than a day across the
// boundary counts only in its creation month.
async function incompleteJobsInMonth(ctx: QueryCtx, month: string, timezone: string) {
  const start = new Date(`${month}-01T00:00:00Z`);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  const padding = 2 * dayMs;
  const jobs = await ctx.db.query("reviewJobs").withIndex("by_usage_incomplete", (q) =>
    q.eq("usageIncomplete", true).gte("_creationTime", start.getTime() - padding).lt("_creationTime", end.getTime() + padding)).collect();
  return jobs.filter((job) => job.firstUsageDay?.startsWith(month) || monthOf(job._creationTime, timezone) === month);
}

// One row per budget owner with a usageMonthly row or a flagged job in the month, highest spend first.
async function developerTotals(ctx: QueryCtx, rows: Doc<"usageMonthly">[], defaultBudgetUsd: number, incomplete: Job[]) {
  const byDeveloper = new Map(rows.map((row) => [row.developerId, row]));
  const developerIds = new Set([...byDeveloper.keys(), ...incomplete.map((job) => job.developerId)]);
  const totals = await Promise.all([...developerIds].map(async (developerId) => {
    const [developer, budget] = await Promise.all([
      ctx.db.get(developerId),
      ctx.db.query("budgets").withIndex("by_developer", (q) => q.eq("developerId", developerId)).unique(),
    ]);
    const own = byDeveloper.get(developerId);
    return {
      developerId, gitlabUserId: developer?.gitlabUserId ?? null, username: developer?.username ?? null, displayName: developer?.displayName ?? null, blocked: developer?.blocked ?? false,
      costUsd: usdOf(own?.costMicroUsd ?? 0), budgetUsd: budget?.monthlyUsd ?? defaultBudgetUsd, budgetOverride: budget !== null,
      reviews: own?.reviews ?? 0, incompleteJobs: incomplete.filter((job) => job.developerId === developerId).length,
    };
  }));
  return totals.sort((a, b) => b.costUsd - a.costUsd);
}

// One month for the headline, the daily chart per lab, the breakdown tables, and the working-day burn rate.
// Reads usageDaily for the month's days and usageMonthly for the by-owner table; the ledger itself is never scanned.
export const spend = query({
  args: { ...adminAuth, month: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireAdmin(args.adminSecret);
    const now = Date.now();
    const settings = await loadSettings(ctx);
    const timezone = settings.orgTimezone;
    const today = dayOf(now, timezone);
    const month = args.month ?? monthOf(now, timezone);
    const working = workingDays(month, today);
    const days = daysOfMonth(month, today);
    const [monthRows, monthlyRows] = await Promise.all([
      ctx.db.query("usageDaily").withIndex("by_day_provider_model", (q) => q.gte("day", `${month}-01`).lte("day", `${month}-31`)).collect(),
      ctx.db.query("usageMonthly").withIndex("by_month", (q) => q.eq("month", month)).collect(),
    ]);
    const monthCostUsd = totalsOf(monthRows).costUsd;
    const perWorkingDayUsd = working.elapsed ? monthCostUsd / working.elapsed : null;
    const byLab = labTotals(monthRows);
    const dailyCost = (day: string) => Object.fromEntries(byLab.map(({ lab }) => [lab, totalsOf(monthRows.filter((row) => row.day === day && labOf(row) === lab)).costUsd]));
    return {
      now, today, month,
      monthly: {
        days, costUsd: monthCostUsd, workingDays: working, perWorkingDayUsd,
        byLab,
        daily: days.map((day) => ({ day, byLab: dailyCost(day) })),
        projectedUsd: perWorkingDayUsd === null ? null : perWorkingDayUsd * working.total,
        byModel: modelTotals(monthRows),
        byDeveloper: await developerTotals(ctx, monthlyRows, settings.defaultBudgetUsd, await incompleteJobsInMonth(ctx, month, timezone)),
      },
    };
  },
});
