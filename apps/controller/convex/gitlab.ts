import type { TriggerKind } from "@fred/contracts";
import { z } from "zod";

const reviewer = z.object({
  id: z.number(),
  username: z.string(),
  re_requested: z.boolean().optional(),
});

// GitLab 18 sends `changes.reviewers` as { previous, current }, GitLab 19 as
// [previous, current]. Both parse to the tuple form.
const reviewerChange = z
  .union([
    z.tuple([z.array(reviewer), z.array(reviewer)]),
    z.object({ previous: z.array(reviewer), current: z.array(reviewer) }).transform((c) => [c.previous, c.current] as const),
  ])
  .optional();

const mergeRequestEvent = z.object({
  object_kind: z.literal("merge_request"),
  user: z.object({ id: z.number(), username: z.string(), name: z.string().nullish() }),
  project: z.object({ id: z.number(), path_with_namespace: z.string() }),
  object_attributes: z.object({
    iid: z.number(),
    author_id: z.number(),
    action: z.string().optional(),
    oldrev: z.string().nullish(),
    last_commit: z.object({ id: z.string() }),
  }),
  changes: z.object({ reviewers: reviewerChange }).optional(),
  reviewers: z.array(reviewer).optional(),
});

type MergeRequestEvent = z.infer<typeof mergeRequestEvent>;

// The merge request event in a webhook body, `invalid` with the first schema issue, or `other` for any other event kind.
export function parseWebhook(body: unknown) {
  const kind = typeof body === "object" && body !== null ? Reflect.get(body, "object_kind") : undefined;
  if (kind !== "merge_request") return { kind: "other" } as const;
  const parsed = mergeRequestEvent.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const reason = issue ? `${issue.path.join(".")}: ${issue.message}` : "invalid merge_request payload";
    return { kind: "invalid", reason } as const;
  }
  return { kind: "merge_request", event: parsed.data } as const;
}

// Returns the review request for bot `botId` in one merge request event, or undefined. MRs authored by `botId` or any of
// `botAuthorIds` trigger only when someone adds or re-requests the bot, and that user owns the budget.
export function detectTrigger(event: MergeRequestEvent, botId: string, botAuthorIds: string[] = []) {
  const attrs = event.object_attributes;
  if (attrs.action !== "open" && attrs.action !== "update") return undefined;

  const [previous, current] = event.changes?.reviewers ?? [[], []];
  const assigned = event.reviewers ?? [];
  const authorId = String(attrs.author_id);
  const triggerUserId = String(event.user.id);
  const authorIsBot = [botId, ...botAuthorIds].includes(authorId);

  const has = (list: { id: number }[]) => list.some((r) => String(r.id) === botId);
  const entry = current.find((r) => String(r.id) === botId);
  const kind: TriggerKind | undefined =
    attrs.action === "open" ? (has(assigned) && !authorIsBot ? "mr_opened" : undefined)
    : entry && !has(previous) ? "reviewer_added"
    : entry?.re_requested ? "re_requested"
    : attrs.oldrev && has(assigned) && !authorIsBot ? "push"
    : undefined;
  if (!kind) return undefined;

  const ownerId = authorIsBot ? triggerUserId : authorId;
  const budgetOwner =
    ownerId === triggerUserId ? { gitlabUserId: ownerId, username: event.user.username, ...(event.user.name != null ? { displayName: event.user.name } : {}) } : { gitlabUserId: ownerId };

  return {
    provider: "fred" as const,
    kind,
    headSha: attrs.last_commit.id,
    mrIid: attrs.iid,
    project: { gitlabProjectId: String(event.project.id), path: event.project.path_with_namespace },
    triggeredBy: triggerUserId,
    budgetOwner,
  };
}
