import { z } from "zod";

// How a merge request event asked for a review. One webhook delivery yields at most one trigger.
export const triggerKind = z.enum(["mr_opened", "reviewer_added", "re_requested", "push"]);

// Review job statuses that wait for or hold work, in queue order. Finding commands use the same three.
export const inFlightStatuses = ["queued", "running", "publishing"] as const;

// Review job statuses that end an attempt.
export const finishedStatuses = ["done", "failed", "denied", "superseded", "skipped"] as const;

export const jobStatus = z.enum([...inFlightStatuses, ...finishedStatuses]);

// Policy gates in evaluation order. The first one that fails denies the review.
export const denialGate = z.enum(["maintenance", "disabled", "developer_blocked", "provider_disallowed", "budget_exhausted"]);

export type TriggerKind = z.infer<typeof triggerKind>;
export type DenialGate = z.infer<typeof denialGate>;
