import { z } from "zod";

export const diffRefs = z.object({ base_sha: z.string().min(1), start_sha: z.string().min(1), head_sha: z.string().min(1) });
export const mergeRequest = z.object({
  web_url: z.string().url(), title: z.string(), description: z.string().nullable(), sha: z.string().min(1),
  source_project_id: z.number().int().positive().nullable(),
  diff_refs: diffRefs.nullable(), changes_count: z.string().optional(), state: z.string(),
});
export const diff = z.object({
  old_path: z.string(), new_path: z.string(), diff: z.string(),
  new_file: z.boolean(), renamed_file: z.boolean(), deleted_file: z.boolean(),
  too_large: z.boolean().optional(), collapsed: z.boolean().optional(),
});
export const note = z.object({
  id: z.number().int(), body: z.string(), author: z.object({ id: z.number().int(), username: z.string().optional() }),
  system: z.boolean().optional(), resolvable: z.boolean().optional(), resolved: z.boolean().optional(),
});
export const discussion = z.object({ id: z.string(), notes: z.array(note) });
// GitLab records an empty diff version, with no merge base, when a push produced no diff yet.
export const diffVersion = z.object({ head_commit_sha: z.string().min(1), base_commit_sha: z.string().min(1).nullable() });
export const comparison = z.object({ diffs: z.array(diff), compare_timeout: z.boolean(), overflow: z.boolean().optional() });
export const treeEntry = z.object({
  path: z.string().min(1), id: z.string().min(1), type: z.enum(["tree", "blob", "commit"]), mode: z.string(),
});
export type Diff = z.infer<typeof diff>;
