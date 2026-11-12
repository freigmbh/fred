import { dispositionOf, type Disposition } from "@fred/contracts";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";

type Scope = Pick<Doc<"findings">, "projectId" | "mrIid" | "provider">;

// True once a finding reached GitLab. Only published findings take decisions.
export function isPublished(finding: Pick<Doc<"findings">, "status">) {
  return finding.status === "posted" || finding.status === "resolved";
}

// Open findings can be fixed, dismissed, or retracted; only dismissed and retracted ones reopen.
function transitionAllowed(before: Disposition, after: Disposition) {
  return after === "open" ? before === "dismissed" || before === "retracted" : before === "open";
}

// The ID of the latest decision that changed a disposition on the MR for this provider, or "" before any.
export async function findingRevision(ctx: QueryCtx, scope: Scope) {
  return (await ctx.db.query("findingDecisions").withIndex("by_mr_provider", (q) =>
    q.eq("projectId", scope.projectId).eq("mrIid", scope.mrIid).eq("provider", scope.provider))
    .filter((q) => q.neq(q.field("before"), q.field("after"))).order("desc").first())?._id ?? "";
}

// True while no decision changed a disposition since the job saved its result.
export async function publicationCurrent(ctx: QueryCtx, job: Doc<"reviewJobs">) {
  return (job.findingRevision ?? "") === await findingRevision(ctx, job);
}

// The reference commands use for a finding: its job and result index, or its ID for findings stored before indexes.
export function findingReference(finding: Pick<Doc<"findings">, "_id" | "jobId" | "resultIndex">) {
  return finding.resultIndex === undefined ? finding._id : `${finding.jobId}/${finding.resultIndex}`;
}

// True when a published finding still carries `expectedDecisionId` and may move to `after`.
export function decisionEligible(finding: Doc<"findings">, expectedDecisionId: string | null, after: Disposition) {
  return (finding.decisionId ?? null) === expectedDecisionId && isPublished(finding) && transitionAllowed(dispositionOf(finding), after);
}

// Appends one decision row and updates the finding's disposition. Replaying the same `eventKey` returns the first row.
// Migrations may record transitions the lifecycle otherwise forbids.
export async function applyFindingDecision(ctx: MutationCtx, finding: Doc<"findings">, input: {
  eventKey: string; expectedDecisionId: string | null; after: Disposition; reason: string;
  actorId: string; source: "human" | "validator" | "migration";
  jobId?: Id<"reviewJobs">; commandId?: Id<"findingCommands">; noteId?: string; headSha?: string;
}) {
  const replay = await ctx.db.query("findingDecisions").withIndex("by_event", (q) => q.eq("eventKey", input.eventKey)).unique();
  if (replay) {
    if (replay.findingId !== finding._id || replay.after !== input.after || replay.reason !== input.reason) throw new Error("finding decision replay changed");
    return replay._id;
  }
  if ((finding.decisionId ?? null) !== input.expectedDecisionId) throw new Error("finding decision is outdated");
  if (!isPublished(finding)) throw new Error("finding is not published");
  const before = dispositionOf(finding);
  if (input.source !== "migration" && !transitionAllowed(before, input.after)) throw new Error("finding transition is ineligible");
  const { expectedDecisionId: _, ...record } = input;
  const id = await ctx.db.insert("findingDecisions", {
    ...record, findingId: finding._id, projectId: finding.projectId, mrIid: finding.mrIid, provider: finding.provider,
    before, ...(finding.decisionId ? { supersedes: finding.decisionId } : {}),
  });
  await ctx.db.patch(finding._id, { status: "posted", disposition: input.after, decisionId: id });
  return id;
}

// Every finding of the MR for this provider with its effective disposition, reference, summary note, and decision reason.
export async function findingsFor(ctx: QueryCtx, scope: Scope) {
  const findings = await ctx.db.query("findings").withIndex("by_mr_provider", (q) =>
    q.eq("projectId", scope.projectId).eq("mrIid", scope.mrIid).eq("provider", scope.provider)).collect();
  return Promise.all(findings.map(async (finding) => {
    const job = await ctx.db.get(finding.jobId);
    const decision = finding.decisionId ? await ctx.db.get(finding.decisionId) : null;
    return { ...finding, disposition: dispositionOf(finding), reference: findingReference(finding),
      ...(job?.summaryNoteId ? { summaryNoteId: job.summaryNoteId } : {}),
      ...(decision ? { decisionReason: decision.reason } : {}) };
  }));
}
