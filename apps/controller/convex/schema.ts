import { denialGate as denialGates, disposition as dispositions, findingStatus as findingStatuses, jobStatus as jobStatuses,
  provider as providers, severity as severities, stage as stages } from "@fred/contracts";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { literals } from "./validators";

export const provider = literals(providers.options);
const jobStatus = literals(jobStatuses.options);

export const failureReason = v.union(
  v.literal("error"),
  v.literal("max_turns"),
  v.literal("timeout"),
  v.literal("label_missing"),
  v.literal("stale"),
);

export const stage = literals(stages.options);

// Stored selections stay loose: historical jobs hold models and efforts the current contract rejects.
const modelSelection = v.object({ model: v.string(), effort: v.string() });
export const stageModels = v.object({ detect: modelSelection, validate: modelSelection });
const retiredReviewModels = v.object({ claude: stageModels, codex: stageModels });

export const catalogModel = v.object({
  id: v.string(), label: v.string(), contextLength: v.number(), maxCompletionTokens: v.union(v.number(), v.null()),
  supportedParameters: v.array(v.string()), efforts: v.array(v.string()), defaultEffort: v.string(), reasoningMandatory: v.boolean(),
});

const denialGate = literals(denialGates.options);

export const failureKind = v.union(v.literal("failed"), v.literal("denied"), v.literal("note_failed"));

const severity = literals(severities.options);
const disposition = literals(dispositions.options);
const findingStatus = literals(findingStatuses.options);

const findingFields = {
  file: v.string(),
  line: v.optional(v.number()),
  oldLine: v.optional(v.number()),
  severity,
  title: v.string(),
  body: v.string(),
  status: findingStatus,
  rejectReason: v.optional(v.string()),
  discussionId: v.optional(v.string()),
  disposition: v.optional(disposition),
};

export const mrNoteFields = {
  jobId: v.optional(v.id("reviewJobs")),
  failureJson: v.optional(v.string()),
  key: v.string(),
  gitlabProjectId: v.string(),
  projectPath: v.string(),
  mrIid: v.number(),
  provider,
  body: v.string(),
};

export const commandAction = v.union(v.literal("dismiss"), v.literal("undo"));

export const findingCommandRequestInput = v.object({
  mrIid: v.number(), actorId: v.string(), action: commandAction,
  reference: v.string(), reason: v.string(), body: v.string(),
});

const transcriptOutcome = v.union(v.literal("completed"), v.literal("failed"), v.literal("timed_out"), v.literal("interrupted"));

// One stage attempt's transcript as the worker reports it. A file above the worker's size limit is recorded as omitted.
export const transcriptFields = {
  stage, model: v.string(), effort: v.string(), outcome: transcriptOutcome, omitted: v.optional(v.literal("too_large")),
  turns: v.number(), toolCalls: v.number(), durationMs: v.number(), release: v.optional(v.string()), fredVersion: v.optional(v.string()), reviewRulesSha: v.optional(v.string()),
};

const findingCommandRequestFailure = v.union(v.literal("configuration"), v.literal("gitlab"), v.literal("exhausted"));

export default defineSchema({
  modelCatalog: defineTable({ models: v.array(catalogModel), fetchedAt: v.number() }),

  settings: defineTable({
    globalEnabled: v.boolean(),
    defaultBudgetUsd: v.number(),
    orgTimezone: v.string(),
    // Unused, like modelsRevision. Convex refuses a schema push while stored documents hold fields the schema lacks, so both
    // stay until a migration clears them.
    reviewModels: v.optional(retiredReviewModels),
    modelsRevision: v.optional(v.number()),
  }),

  developers: defineTable({
    gitlabUserId: v.string(),
    username: v.optional(v.string()),
    displayName: v.optional(v.string()),
    blocked: v.optional(v.boolean()),
    blockedReason: v.optional(v.string()),
  }).index("by_gitlab_user", ["gitlabUserId"]),

  budgets: defineTable({
    developerId: v.id("developers"),
    monthlyUsd: v.number(),
  }).index("by_developer", ["developerId"]),

  projects: defineTable({
    gitlabProjectId: v.string(),
    path: v.string(),
    collectTranscripts: v.optional(v.boolean()),
    // The review pipeline new jobs snapshot at enqueue. Set when the project is connected; the revision guards stale saves.
    stageModels: v.optional(stageModels),
    pipelineRevision: v.optional(v.number()),
    // Every bot user a FRED token had in this project, oldest first, so a replaced token still owns its discussions.
    botUserIds: v.optional(v.array(v.string())),
  }).index("by_gitlab_project", ["gitlabProjectId"]).index("by_path", ["path"]),

  // The "0 FRED" project access token of a connected project, sealed with FRED_TOKEN_KEY. Its bot user is FRED in that project.
  projectTokens: defineTable({
    projectId: v.id("projects"),
    sealedToken: v.string(),
    tokenId: v.number(),
    name: v.string(),
    scopes: v.array(v.string()),
    // yyyy-mm-dd as GitLab reports it, null for a token without expiry.
    expiresAt: v.union(v.string(), v.null()),
    botUserId: v.string(),
    botUsername: v.string(),
    accessLevel: v.number(),
    checkedAt: v.number(),
    // Why the last GitLab check failed, such as a revoked token. Cleared by the next passing check.
    problem: v.optional(v.string()),
  }).index("by_project", ["projectId"]),

  projectPolicies: defineTable({
    projectId: v.id("projects"),
    provider,
    allowed: v.boolean(),
  }).index("by_project_provider", ["projectId", "provider"]),

  reviewJobs: defineTable({
    projectId: v.id("projects"),
    mrIid: v.number(),
    headSha: v.string(),
    previousReviewedSha: v.optional(v.string()),
    stageModels: v.optional(stageModels),
    collectTranscripts: v.optional(v.boolean()),
    provider,
    status: jobStatus,
    developerId: v.id("developers"),
    triggeredBy: v.string(),
    failureReason: v.optional(failureReason),
    // The text of the job's denial or failure comment.
    denialReason: v.optional(v.string()),
    claimedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    workerId: v.optional(v.string()),
    leaseToken: v.optional(v.string()),
    leaseGeneration: v.optional(v.number()),
    leaseExpiresAt: v.optional(v.number()),
    resultJson: v.optional(v.string()),
    // The FRED release whose worker produced resultJson. Absent before versioned releases and for local workers.
    fredVersion: v.optional(v.string()),
    findingRevision: v.optional(v.string()),
    summaryNoteId: v.optional(v.string()),
    diagnosticJson: v.optional(v.string()),
    publicationAcks: v.optional(v.array(v.object({ key: v.string(), discussionId: v.optional(v.string()), noteId: v.optional(v.string()) }))),
    usageIncomplete: v.optional(v.boolean()),
    usageConfirmedStages: v.optional(v.array(stage)),
    usageIncompleteReason: v.optional(v.string()),
    deliveryKey: v.optional(v.string()),
    deadlineAt: v.optional(v.number()),
    // The day of the job's first priced usage row. Set once by the rollup writer; the job counts as one review there.
    firstUsageDay: v.optional(v.string()),
  })
    .index("by_project", ["projectId"])
    .index("by_status_provider", ["status", "provider"])
    .index("by_status_expiry", ["status", "leaseExpiresAt"])
    .index("by_status_completed", ["status", "completedAt"])
    .index("by_usage_incomplete", ["usageIncomplete"])
    .index("by_legacy_deadline", ["status", "leaseExpiresAt", "deadlineAt"])
    .index("by_mr", ["projectId", "mrIid"])
    .index("by_dedupe", ["projectId", "mrIid", "headSha", "provider"])
    .index("by_dedupe_status", ["projectId", "mrIid", "headSha", "provider", "status"]),

  diagnosticSnapshots: defineTable({ jobId: v.id("reviewJobs"), snapshotJson: v.string() }).index("by_job", ["jobId"]),

  diagnosticEvents: defineTable({
    eventJson: v.string(),
    jobId: v.optional(v.id("reviewJobs")),
    gitlabProjectId: v.optional(v.string()),
    projectPath: v.optional(v.string()),
    mrIid: v.optional(v.number()),
    provider: v.optional(provider),
    leaseGeneration: v.optional(v.number()),
    recordedAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_project", ["gitlabProjectId", "recordedAt"])
    .index("by_path_mr", ["projectPath", "mrIid", "recordedAt"])
    .index("by_recorded", ["recordedAt"])
    .index("by_expiry", ["expiresAt"])
    .index("by_job", ["jobId", "recordedAt"])
    .index("by_mr", ["gitlabProjectId", "mrIid", "recordedAt"]),

  // One gzipped JSON file in file storage per stage attempt of a collecting job. `bytes` is the gzipped size, 0 when omitted.
  transcripts: defineTable({
    jobId: v.id("reviewJobs"), leaseGeneration: v.number(), ...transcriptFields,
    storageId: v.optional(v.id("_storage")), bytes: v.number(), recordedAt: v.number(),
  }).index("by_job", ["jobId", "leaseGeneration", "stage"]),

  webhookDeliveries: defineTable({ key: v.string() }).index("by_key", ["key"]),

  usageEvents: defineTable({
    eventKey: v.optional(v.string()),
    incomplete: v.optional(v.boolean()),
    jobId: v.id("reviewJobs"),
    developerId: v.id("developers"),
    month: v.string(),
    // Absent on rows written before the column existed until migrations.backfillUsageDay stamps them.
    day: v.optional(v.string()),
    provider,
    model: v.string(),
    stage,
    inputTokens: v.number(),
    cachedInputTokens: v.number(),
    outputTokens: v.number(),
    costUsd: v.number(),
    priceTableVersion: v.string(),
    // The FRED release whose worker reported the usage.
    fredVersion: v.optional(v.string()),
    supersedes: v.optional(v.id("usageEvents")),
    // True once the row is in usageDaily and usageMonthly. recordUsage sets it at insert; migrations.backfillUsageRollups
    // sets it on older rows so a rerun adds nothing twice.
    rolledUp: v.optional(v.boolean()),
  })
    .index("by_developer_month", ["developerId", "month"])
    .index("by_day", ["day"])
    .index("by_job", ["jobId"])
    .index("by_event", ["jobId", "eventKey"])
    .index("by_rolled_up", ["rolledUp"]),

  // Sums of usageEvents per org-local day, provider, and model. Cost is integer micro-dollars. `reviews` counts jobs
  // whose first priced row fell on the day. Maintained by the rollup writer in the ledger insert's transaction.
  usageDaily: defineTable({
    day: v.string(),
    provider,
    model: v.string(),
    costMicroUsd: v.number(),
    inputTokens: v.number(),
    cachedInputTokens: v.number(),
    outputTokens: v.number(),
    reviews: v.number(),
  }).index("by_day_provider_model", ["day", "provider", "model"]),

  // Sums of usageEvents per yyyy-mm month and budget owner, same amounts as usageDaily. The budget gate reads one row.
  usageMonthly: defineTable({
    month: v.string(),
    developerId: v.id("developers"),
    costMicroUsd: v.number(),
    inputTokens: v.number(),
    cachedInputTokens: v.number(),
    outputTokens: v.number(),
    reviews: v.number(),
  })
    .index("by_developer_month", ["developerId", "month"])
    .index("by_month", ["month"]),

  // One row per done job, written by jobs.complete in the same transaction, so admin.overview reads a month of small rows
  // instead of every done job's saved result. Finding counts are final then: later decisions change disposition, not severity.
  reviewOutcomes: defineTable({
    jobId: v.id("reviewJobs"),
    provider,
    completedAt: v.number(),
    clean: v.boolean(),
    findings: v.object({ blocking: v.number(), should_fix: v.number(), nit: v.number() }),
    validatorRejected: v.number(),
    claimWaitMs: v.optional(v.number()),
    runMs: v.optional(v.number()),
  }).index("by_completed", ["completedAt"]).index("by_job", ["jobId"]),

  reviewFailures: defineTable({
    jobId: v.optional(v.id("reviewJobs")),
    noteId: v.optional(v.id("mrNotes")),
    leaseGeneration: v.optional(v.number()),
    projectId: v.id("projects"),
    mrIid: v.number(),
    provider,
    kind: failureKind,
    reason: v.union(failureReason, denialGate, v.literal("delivery")),
    summary: v.string(),
    failureCategory: v.optional(v.string()),
    providerCode: v.optional(v.string()),
    developerId: v.optional(v.id("developers")),
    triggeredBy: v.optional(v.string()),
    at: v.number(),
  }).index("by_at", ["at"]).index("by_kind_at", ["kind", "at"]).index("by_job", ["jobId"]),

  findings: defineTable({
    jobId: v.id("reviewJobs"),
    projectId: v.id("projects"),
    mrIid: v.number(),
    provider,
    ...findingFields,
    resultIndex: v.optional(v.number()),
    decisionId: v.optional(v.id("findingDecisions")),
    noteId: v.optional(v.string()),
  })
    .index("by_job", ["jobId"])
    .index("by_mr_provider", ["projectId", "mrIid", "provider"]),

  findingDecisions: defineTable({
    findingId: v.id("findings"), projectId: v.id("projects"), mrIid: v.number(), provider,
    eventKey: v.string(), before: disposition, after: disposition, reason: v.string(),
    actorId: v.string(), source: v.union(v.literal("human"), v.literal("validator"), v.literal("migration")),
    jobId: v.optional(v.id("reviewJobs")), commandId: v.optional(v.id("findingCommands")),
    noteId: v.optional(v.string()), headSha: v.optional(v.string()), supersedes: v.optional(v.id("findingDecisions")),
  }).index("by_event", ["eventKey"]).index("by_finding", ["findingId"])
    .index("by_mr_provider", ["projectId", "mrIid", "provider"]),

  findingCommandRequests: defineTable({
    projectId: v.id("projects"), noteId: v.string(), command: findingCommandRequestInput,
    status: v.union(v.literal("pending"), v.literal("verifying"), v.literal("done"), v.literal("ignored"), v.literal("failed")),
    attempts: v.number(), nextAttemptAt: v.number(), failure: v.optional(findingCommandRequestFailure),
  }).index("by_note", ["projectId", "noteId"]),

  findingCommands: defineTable({
    projectId: v.id("projects"), mrIid: v.number(), provider, noteId: v.string(), actorId: v.string(),
    action: commandAction, findingId: v.id("findings"),
    expectedDecisionRef: v.union(v.string(), v.null()), reason: v.string(),
    status: v.union(v.literal("queued"), v.literal("running"), v.literal("publishing"), v.literal("done"), v.literal("failed")),
    workerId: v.optional(v.string()), leaseToken: v.optional(v.string()), leaseExpiresAt: v.optional(v.number()),
    leaseGeneration: v.optional(v.number()), resultJson: v.optional(v.string()),
    publicationAcks: v.array(v.string()), failure: v.optional(v.string()),
  }).index("by_note", ["projectId", "noteId"]).index("by_status_provider", ["status", "provider"])
    .index("by_mr", ["projectId", "mrIid"]),

  mrNotes: defineTable({
    ...mrNoteFields,
    status: v.union(v.literal("pending"), v.literal("sent"), v.literal("failed")),
    attempts: v.number(),
    lastError: v.optional(v.string()),
  }).index("by_key", ["key"]).index("by_job", ["jobId"]).index("by_mr", ["gitlabProjectId", "mrIid"]),

  providerCostSnapshots: defineTable({
    provider,
    day: v.string(),
    costUsd: v.number(),
    fetchedAt: v.number(),
  }).index("by_provider_day", ["provider", "day"]),

  policyAudit: defineTable({
    actor: v.string(),
    table: v.string(),
    rowId: v.string(),
    before: v.string(),
    after: v.string(),
    at: v.number(),
  }).index("by_at", ["at"]),
});
