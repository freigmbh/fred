import { z } from "zod";
import { denialGate } from "./jobs";
import { modelEffort } from "./models";
import { failureDetailLimit } from "./redaction";

const diagnosticPhase = z.enum(["webhook", "queue", "context", "checkout", "instructions", "detect", "validate", "save", "publish", "complete"]);
const failureCategory = z.enum(["authentication", "quota", "rate_limit", "invalid_request", "configuration", "process", "transport", "output", "timeout", "controller", "gitlab", "sandbox", "checkout", "provider", "unexpected"]);
export const controllerOperation = z.enum(["jobs:claim", "jobs:listQueued", "jobs:heartbeat", "jobs:previousFindings", "jobs:saveResult", "jobs:ackPublication", "jobs:complete", "jobs:supersede", "jobs:skip", "jobs:fail", "jobs:interruptAnalysis", "jobs:recordUsage", "jobs:confirmUsage", "jobs:markUsageIncomplete", "diagnostics:record", "transcripts:store", "findingCommands:heartbeat", "findingCommands:context", "findingCommands:reconcileSummary", "findingCommands:prepare", "findingCommands:acknowledge", "findingCommands:fail"]);
const controllerFailure = z.object({
  operation: controllerOperation,
  reason: z.enum(["timeout", "disconnected", "rejected", "lease_lost"]),
  elapsedMs: z.number().int().nonnegative(),
  connected: z.boolean(),
}).strict();
export const providerValidationIssue = z.object({
  code: z.enum(["invalid_type", "too_big", "too_small", "invalid_format", "not_multiple_of", "unrecognized_keys", "invalid_union", "invalid_key", "invalid_element", "invalid_value", "custom"]),
  path: z.array(z.union([
    z.enum(["candidates", "verdicts", "findingDecisions", "index", "verdict", "reason", "file", "line", "oldLine", "severity", "title", "body", "findingId", "disposition"]),
    z.number().int().nonnegative(),
  ])).max(8),
}).strict();
const providerFailure = z.object({
  source: z.enum(["openrouter"]),
  code: z.enum(["unknown", "rateLimitExceeded", "serverOverloaded", "internalServerError", "unauthorized", "badRequest", "invalid_json", "mixed_submission", "schema_mismatch", "string_too_long", "context_length_exceeded", "payload_too_large"]),
  validationIssues: z.array(providerValidationIssue).max(8).optional(),
}).strict();
export const diagnosticRequest = z.object({
  bytes: z.number().int().nonnegative(),
  messageCount: z.number().int().nonnegative(),
  largestMessageCharacters: z.number().int().nonnegative(),
}).strict();
export type DiagnosticRequest = z.infer<typeof diagnosticRequest>;
export const diagnosticFailure = z.object({
  provider: providerFailure.optional(),
  controller: controllerFailure.optional(),
  request: diagnosticRequest.optional(),
  category: failureCategory,
  code: z.enum(["ENOENT", "EACCES", "ENOEXEC", "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "EPIPE", "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "invalid_api_key", "insufficient_quota", "invalid_schema", "invalid_model", "unknown_option", "missing_result", "invalid_result", "missing_provider_key", "diff_recovery_failed", "review_input_too_large"]).optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
  exitCode: z.number().int().min(-1).max(255).optional(),
  signal: z.enum(["SIGTERM", "SIGKILL", "SIGABRT", "SIGSEGV", "SIGINT", "SIGPIPE", "SIGBUS", "SIGILL"]).optional(),
  detail: z.string().max(failureDetailLimit).optional(),
}).strict();
export type DiagnosticFailure = z.infer<typeof diagnosticFailure>;

export const diagnosticEvent = z.object({
  kind: z.enum(["phase_started", "phase_completed", "provider_activity", "tool_started", "tool_completed", "process_exited", "api_response", "api_rejected", "submission_rejected", "publication_attempt", "publication_acknowledged", "failed", "interrupted", "diagnostics_dropped", "webhook_received", "webhook_ignored", "webhook_invalid", "webhook_unauthorized", "duplicate", "denied", "queued", "claimed", "superseded", "skipped", "completed", "note_attempt"]),
  phase: diagnosticPhase,
  at: z.number().int().nonnegative(),
  sequence: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  tool: z.enum(["read", "read_diff", "list_diffs", "glob", "grep", "list_skills", "load_skill", "denied"]).optional(),
  outcome: z.enum(["success", "failure", "pending", "sent", "ignored", "retry", "recovered"]).optional(),
  reason: z.enum([...denialGate.options, "no_trigger", "unconfigured", "retired_bot", "unsupported_event", "invalid_payload", "unauthorized", "duplicate_delivery", "duplicate_review", "lease_expired", "new_head", "unchanged", "controller_unavailable", "worker_stopped"]).optional(),
  effect: z.enum(["summary", "finding", "resolve", "label"]).optional(),
  effectIndex: z.number().int().nonnegative().optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
  failure: diagnosticFailure.optional(),
  release: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  model: z.string().regex(/^[A-Za-z0-9~._:/-]{1,200}$/).optional(),
  effort: modelEffort.optional(),
}).strict();
export type DiagnosticEvent = z.infer<typeof diagnosticEvent>;

export const diagnosticSnapshot = z.object({
  phase: diagnosticPhase,
  at: z.number().int().nonnegative(),
  lastActivityAt: z.number().int().nonnegative().optional(),
  release: diagnosticEvent.shape.release,
  model: diagnosticEvent.shape.model,
  effort: diagnosticEvent.shape.effort,
  failure: diagnosticFailure.optional(),
  droppedEvents: z.number().int().nonnegative(),
  leaseGeneration: z.number().int().nonnegative(),
}).strict();
export type DiagnosticSnapshot = z.infer<typeof diagnosticSnapshot>;

// Stored diagnostics also hold what the retired native Codex and Claude runtimes and the old Anthropic proxy recorded.
// The stored* schemas read that history; nothing writes it any more, so the schemas above reject it.
const storedProviderFailure = providerFailure.extend({
  source: z.enum([...providerFailure.shape.source.options, "codex_turn", "codex_rpc", "codex_protocol", "claude_result", "claude_stream"]),
  code: z.enum([...providerFailure.shape.code.options, "contextWindowExceeded", "sessionBudgetExceeded", "usageLimitExceeded", "cyberPolicy", "misalignmentPolicyViolation", "httpConnectionFailed", "responseStreamConnectionFailed", "threadRollbackFailed", "sandboxError", "responseStreamDisconnected", "responseTooManyFailedAttempts", "activeTurnNotSteerable", "other", "error_during_execution", "error_max_turns", "error_max_budget_usd", "error_max_structured_output_retries", "invalid_frame", "frame_limit", "notification_limit"]),
  rpcCode: z.number().int().min(-2147483648).max(2147483647).optional(),
});
const storedDiagnosticFailure = diagnosticFailure.extend({ provider: storedProviderFailure.optional() });
export const storedDiagnosticEvent = diagnosticEvent.extend({
  kind: z.enum([...diagnosticEvent.shape.kind.options, "process_started", "api_failed"]),
  reason: z.enum([...diagnosticEvent.shape.reason.unwrap().options, "policy"]).optional(),
  failure: storedDiagnosticFailure.optional(),
  requestId: z.string().regex(/^(req_[A-Za-z0-9]{1,100}|[a-f0-9-]{36})$/).optional(),
  route: z.enum(["messages", "count_tokens", "blocked"]).optional(),
  requestCount: z.number().int().nonnegative().optional(),
  stderrBytes: z.number().int().nonnegative().optional(),
  runtimeVersion: z.string().regex(/^\d+\.\d+\.\d+$/).optional(),
});
export const storedDiagnosticSnapshot = diagnosticSnapshot.extend({ failure: storedDiagnosticFailure.optional() });
export type StoredDiagnosticFailure = z.infer<typeof storedDiagnosticFailure>;
export type StoredDiagnosticSnapshot = z.infer<typeof storedDiagnosticSnapshot>;
export type StoredDiagnosticEvent = z.infer<typeof storedDiagnosticEvent>;

const categorySummaries = {
  authentication: "Provider authentication failed; check the configured API credential",
  quota: "Provider quota is exhausted",
  rate_limit: "Provider rate limit was reached",
  invalid_request: "Provider rejected the request; check model, options, and output schema",
  configuration: "Runtime configuration is invalid",
  process: "Provider process could not start or exited unexpectedly",
  transport: "Provider connection failed",
  output: "Provider output did not match the review contract",
  timeout: "The operation exceeded its deadline",
  controller: "Controller communication or job ownership failed",
  gitlab: "GitLab request failed",
  sandbox: "Review sandbox rejected an operation",
  checkout: "Repository checkout failed",
  provider: "Provider review failed; inspect structured diagnostics",
  unexpected: "Unexpected worker failure",
} satisfies Record<DiagnosticFailure["category"], string>;

// Failures FRED detects itself. Their summary is the whole text; no upstream detail adds to it.
const completeSummaries: Partial<Record<NonNullable<StoredDiagnosticFailure["code"]>, string>> = {
  diff_recovery_failed: "GitLab diff recovery failed; complete review input could not be verified",
  review_input_too_large: "Review input exceeds FRED's initial prompt limit; repository instructions or review metadata could not fit",
};

// Provider codes precise enough to replace their category's summary.
const providerSummaries: Partial<Record<NonNullable<StoredDiagnosticFailure["provider"]>["code"], string>> = {
  string_too_long: "Provider rejected a string that exceeds its length limit",
  context_length_exceeded: "Provider rejected input that exceeds the model context window",
  payload_too_large: "Provider rejected a request that exceeds its payload size limit",
};

// The classified one-line text of a failure for MR comments, failure rows, and the admin UI. Never includes `detail`.
export function failureSummary(failure: StoredDiagnosticFailure) {
  const complete = failure.code && completeSummaries[failure.code];
  if (complete) return complete;
  const summary = (failure.provider && providerSummaries[failure.provider.code]) || categorySummaries[failure.category];
  const details = [failure.provider?.source, failure.provider?.code === "unknown" ? undefined : failure.provider?.code,
    failure.provider?.rpcCode === undefined ? undefined : `RPC ${failure.provider.rpcCode}`, failure.controller?.operation, failure.controller?.reason, failure.code, failure.httpStatus === undefined ? undefined : `HTTP ${failure.httpStatus}`,
    failure.exitCode === undefined ? undefined : `exit ${failure.exitCode}`, failure.signal].filter((value) => value !== undefined);
  return `${summary}${details.length ? ` (${details.join(", ")})` : ""}`;
}
