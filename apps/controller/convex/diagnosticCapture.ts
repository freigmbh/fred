import { storedDiagnosticEvent, storedDiagnosticSnapshot, type StoredDiagnosticEvent, type StoredDiagnosticSnapshot } from "@fred/contracts";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";

type ContextFields = Pick<Doc<"diagnosticEvents">, "jobId" | "gitlabProjectId" | "projectPath" | "mrIid" | "provider" | "leaseGeneration">;
type Context = { [Key in keyof ContextFields]?: ContextFields[Key] | undefined };

// How long diagnostic events stay queryable before the prune cron deletes them.
export const diagnosticRetentionMs = 7 * 24 * 60 * 60 * 1000;

export const snapshotJsonLimit = 16_384;

const warnRecordingFailed = () => console.warn("FRED controller diagnostic recording failed");

// A stored snapshot, including history the current contract no longer writes. Undefined when absent, oversized, or unreadable.
export function readSnapshot(json: string | undefined) {
  if (!json || json.length > snapshotJsonLimit) return undefined;
  try {
    const parsed = storedDiagnosticSnapshot.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : undefined;
  } catch { return undefined; }
}

// Combines two snapshots of a job: a newer lease generation replaces an older one; within a generation the later one wins,
// except that a recorded failure and its phase survive a later snapshot without one.
export function mergeSnapshot(previous: StoredDiagnosticSnapshot | undefined, next: StoredDiagnosticSnapshot): StoredDiagnosticSnapshot {
  if (!previous || next.leaseGeneration > previous.leaseGeneration) return next;
  if (next.leaseGeneration < previous.leaseGeneration) return previous;
  const [latest, other] = next.at >= previous.at ? [next, previous] : [previous, next];
  const failure = latest.failure ?? other.failure;
  const phaseSource = latest.failure || !other.failure ? latest : other;
  const activity = [previous.lastActivityAt, next.lastActivityAt].filter((at) => at !== undefined);
  return {
    ...previous,
    ...next,
    ...latest,
    phase: phaseSource.phase,
    ...(phaseSource.model ? { model: phaseSource.model } : {}),
    ...(phaseSource.effort ? { effort: phaseSource.effort } : {}),
    ...(failure ? { failure } : {}),
    ...(activity.length ? { lastActivityAt: Math.max(...activity) } : {}),
    droppedEvents: Math.max(previous.droppedEvents, next.droppedEvents),
    leaseGeneration: next.leaseGeneration,
  };
}

// The worker snapshot merged with the lifecycle outcome on the job, by lease generation. Undefined before the first record.
export async function jobSnapshot(ctx: QueryCtx, job: Doc<"reviewJobs">) {
  const row = await ctx.db.query("diagnosticSnapshots").withIndex("by_job", (q) => q.eq("jobId", job._id)).unique();
  const workerSnapshot = readSnapshot(row?.snapshotJson);
  const lifecycleSnapshot = readSnapshot(job.diagnosticJson);
  return lifecycleSnapshot ? mergeSnapshot(workerSnapshot, lifecycleSnapshot) : workerSnapshot;
}

// Records one validated event, and merges `snapshot` into the job's lifecycle snapshot when given. The event may echo a
// failure read from history. Best-effort: a failure logs a warning and never fails the caller.
export async function capture(ctx: MutationCtx, context: Context, event: StoredDiagnosticEvent, snapshot?: StoredDiagnosticSnapshot) {
  try {
    const eventJson = JSON.stringify(storedDiagnosticEvent.parse(event));
    const recordedAt = Date.now();
    await ctx.db.insert("diagnosticEvents", {
      ...(context.jobId !== undefined ? { jobId: context.jobId } : {}),
      ...(context.gitlabProjectId !== undefined ? { gitlabProjectId: context.gitlabProjectId } : {}),
      ...(context.projectPath !== undefined ? { projectPath: context.projectPath } : {}),
      ...(context.mrIid !== undefined ? { mrIid: context.mrIid } : {}),
      ...(context.provider !== undefined ? { provider: context.provider } : {}),
      ...(context.leaseGeneration !== undefined ? { leaseGeneration: context.leaseGeneration } : {}),
      eventJson, recordedAt, expiresAt: recordedAt + diagnosticRetentionMs });
    if (snapshot && context.jobId) {
      const job = await ctx.db.get(context.jobId);
      if (job) await ctx.db.patch(job._id, { diagnosticJson: JSON.stringify(mergeSnapshot(readSnapshot(job.diagnosticJson), snapshot)) });
    }
  } catch { warnRecordingFailed(); }
}

export async function jobContext(ctx: MutationCtx, job: Doc<"reviewJobs">) {
  const project = await ctx.db.get(job.projectId);
  return { jobId: job._id, gitlabProjectId: project?.gitlabProjectId, projectPath: project?.path, mrIid: job.mrIid, provider: job.provider, leaseGeneration: job.leaseGeneration };
}

// Records a lifecycle event of `job` and advances its lifecycle snapshot to the event's phase. Reads the job again, so a
// document from before the caller's own patch is fine.
export async function captureJob(ctx: MutationCtx, job: Doc<"reviewJobs">, event: StoredDiagnosticEvent) {
  try {
    const current = await ctx.db.get(job._id) ?? job;
    const context = { ...await jobContext(ctx, current), leaseGeneration: current.leaseGeneration ?? 0 };
    const previous = readSnapshot(current.diagnosticJson);
    await capture(ctx, context, event, {
      ...previous, phase: event.phase, at: event.at, droppedEvents: previous?.droppedEvents ?? 0, leaseGeneration: context.leaseGeneration,
      ...(event.failure ? { failure: event.failure } : {}),
    });
  } catch { warnRecordingFailed(); }
}
