import { z } from "zod";

// Severity of a finding. The top two post inline, nits go into the summary.
export const severity = z.enum(["blocking", "should_fix", "nit"]);

// Validator outcomes are stored before publication; pending becomes posted after acknowledgement.
export const findingStatus = z.enum(["pending", "posted", "rejected", "duplicate", "resolved"]);

// What became of a published finding, independent of its status. findingLifecycle.ts decides the transitions.
export const disposition = z.enum(["open", "fixed", "dismissed", "retracted"]);

// Bot identities that own jobs, findings, labels, and usage. `fred` is the bot user of each project's "0 FRED" project
// access token. `claude` and `codex` are the retired shared accounts; their history stays readable but never triggers.
export const provider = z.enum(["claude", "codex", "fred"]);
export const retiredProviders = provider.exclude(["fred"]).options;

// One stage 1 candidate. Permissive by design, validated in stage 2.
export const candidate = z.object({
  file: z.string().min(1),
  line: z.number().int().positive().optional(),
  oldLine: z.number().int().positive().optional(),
  severity,
  title: z.string().min(1),
  body: z.string().min(1),
});

// A finding as the worker stores it and as the reference's findings table
// describes it. Paths are repo-relative; line and oldLine address the new and old versions.
export const finding = candidate.extend({
  status: findingStatus,
  rejectReason: z.string().optional(),
  discussionId: z.string().optional(),
  disposition: disposition.optional(),
});

export type Disposition = z.infer<typeof disposition>;
export type Provider = z.infer<typeof provider>;
export type Candidate = z.infer<typeof candidate>;
export type Finding = z.infer<typeof finding>;
