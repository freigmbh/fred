import type { FailureKind, FinishedStatus, JobStatus, Review, Severity, StageModels } from "./api";

// How a status word reads: ok in green, warn in amber, bad in Bordeaux, off in faint gray.
export type Tone = "ok" | "warn" | "bad" | "off";

type FailureSnapshot = NonNullable<NonNullable<Review>["failure"]>;

export const severities = ["blocking", "should_fix", "nit"] as const satisfies readonly Severity[];
export const severityLabel: Record<Severity, string> = { blocking: "blocking", should_fix: "should fix", nit: "nit" };

export const finishedStatuses = ["done", "failed", "denied", "superseded", "skipped"] as const satisfies readonly FinishedStatus[];
export const finishedStatusLabel: Record<FinishedStatus, string> = { done: "Done", failed: "Failed", denied: "Denied", superseded: "Superseded", skipped: "Skipped" };
// The job statuses whose word carries a tone. Superseded and skipped jobs stopped by design and read as plain faint words.
export const jobStatusTone: Partial<Record<JobStatus, Tone>> = { done: "ok", failed: "bad", denied: "warn" };

export const failureKinds = ["failed", "denied", "note_failed"] as const satisfies readonly FailureKind[];
export const failureKindLabel: Record<FailureKind, string> = { failed: "Failed", denied: "Denied", note_failed: "Note failed" };
export const failureKindTone: Record<FailureKind, Tone> = { failed: "bad", denied: "warn", note_failed: "bad" };

// "2 blocking · 1 nit": each severity with its count, zero counts left out. Empty when every count is zero.
export function findingsText(counts: Record<Severity, number>) {
  return severities.filter((severity) => counts[severity] > 0).map((severity) => `${counts[severity]} ${severityLabel[severity]}`).join(" · ");
}

// A commit SHA cut short: 8 characters in tables, 12 in detail blocks.
export function shortSha(sha: string, length: 8 | 12 = 8) {
  return sha.slice(0, length);
}

// "worker-1 · lease gen 2", each part when known, or "·". Generation 0 means the job was never leased.
export function workerText(workerId: string | null, leaseGeneration: number | null) {
  return [workerId, leaseGeneration ? `lease gen ${leaseGeneration}` : null].filter(Boolean).join(" · ") || "·";
}

// "incomplete · confirmed detect · <reason>": whether a job's usage is complete, the stages whose usage OpenRouter confirmed,
// and the recorded reason when there is one.
export function usageText({ incomplete, confirmedStages, reason = null }: { incomplete: boolean; confirmedStages: readonly string[]; reason?: string | null }) {
  return [incomplete ? "incomplete" : "complete", `confirmed ${confirmedStages.join(", ") || "none"}`, reason].filter(Boolean).join(" · ");
}

// "group/app !12", with a placeholder once the project row is gone.
export function mrLabel(project: { path: string } | null, mrIid: number) {
  return `${project?.path ?? "unknown project"} !${mrIid}`;
}

// The last segment of a GitLab project path: group/sub/app becomes app.
export function projectName(path: string) {
  return path.slice(path.lastIndexOf("/") + 1);
}

// Everything before the last segment of a GitLab project path: group/sub/app becomes group/sub, app becomes "".
export function projectNamespace(path: string) {
  return path.slice(0, Math.max(path.lastIndexOf("/"), 0));
}

// A stage's model selection on one line: "vendor/model · high".
export function selectionText({ model, effort }: StageModels["detect"]) {
  return `${model} · ${effort}`;
}

// Both stage selections, one per line, for a tooltip.
export function stageModelsText(stageModels: StageModels) {
  return `detect ${selectionText(stageModels.detect)}\nvalidate ${selectionText(stageModels.validate)}`;
}

// A stored failure snapshot on one line: category, provider source and code, FRED's code, and the HTTP status, each when known.
export function failureLine(failure: FailureSnapshot) {
  return [failure.category, failure.provider?.source, failure.provider?.code, failure.code, failure.httpStatus ? `HTTP ${failure.httpStatus}` : undefined]
    .filter(Boolean).join(" · ");
}
