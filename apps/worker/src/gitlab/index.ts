import { publicationMarker, reviewLabels, type ReviewVerdict } from "@fred/contracts";
import { Context, Effect, Layer, Schedule } from "effect";
import { z } from "zod";
import { plainHttpUrl } from "../config";
import { GitLabError, LabelMissing } from "../errors";
import type { Position, ReviewContext, ReviewFile } from "../reviewInput";
import { formatPaths } from "./formatPaths";
import { cappedLowerBound, incompleteMrDiff, recoverCappedDiff } from "./cappedDiff";
import { incompleteDiff, recoverDiff } from "./rawDiff";
import { comparison, diff, diffRefs, diffVersion, discussion, mergeRequest, note, treeEntry, type Diff } from "./schemas";

// One claimed MR's GitLab scope. `botUserIds` lists every FRED bot user of the project, so notes and discussions
// an earlier token's bot wrote still count as FRED's.
export type MrScope = { projectId: number; mrIid: number; botUserIds: number[]; token: string };
// A review also pins its claimed head and, for incremental review, the head the previous review covered.
export type ReviewScope = MrScope & { headSha: string; previousReviewedSha?: string | undefined };
type Options = { baseUrl: string; fetch?: typeof fetch };
const retry = { times: 3, schedule: Schedule.exponential("250 millis"), while: (error: GitLabError) => error.retryable === true };

const gitlabPosition = (position: NonNullable<Position>) => ({
  position_type: "text", base_sha: position.baseSha, start_sha: position.startSha, head_sha: position.headSha,
  old_path: position.oldPath, new_path: position.newPath,
  ...(position.newLine ? { new_line: position.newLine } : {}), ...(position.oldLine ? { old_line: position.oldLine } : {}),
});

const sameDiffRefs = (a: z.infer<typeof diffRefs>, b: z.infer<typeof diffRefs> | null) =>
  b !== null && a.base_sha === b.base_sha && a.start_sha === b.start_sha && a.head_sha === b.head_sha;

// Constructs one origin-confined HTTP adapter. Tests supply a fixture transport.
const makeClient = ({ baseUrl, fetch: transport = fetch }: Options, token: string) => {
  const request = <A>(path: string, schema: z.ZodType<A>, method = "GET", body?: unknown, accept: "json" | "text" = "json") => Effect.tryPromise({
    try: async (signal) => {
      if (!plainHttpUrl(baseUrl)) throw new GitLabError({ message: "Invalid GitLab URL" });
      const base = new URL(baseUrl);
      const url = new URL(`${base.pathname.replace(/\/$/, "")}/api/v4/${path}`, base.origin);
      if (url.origin !== base.origin) throw new GitLabError({ message: "GitLab request escaped configured origin" });
      const response = await transport(url, {
        method, headers: { "PRIVATE-TOKEN": token, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      });
      if (!response.ok) {
        const body = (await response.text().catch(() => "")).slice(0, 65_536);
        throw new GitLabError({ message: `GitLab ${method} ${url.pathname} failed (${response.status})`, status: response.status, retryable: response.status === 408 || response.status === 429 || response.status >= 500, ...(body ? { body } : {}) });
      }
      const parsed = schema.safeParse(accept === "text" ? await response.text() : await response.json());
      if (!parsed.success) throw new GitLabError({ message: `GitLab ${method} ${url.pathname} returned an invalid response`, body: z.prettifyError(parsed.error) });
      return { data: parsed.data, next: response.headers.get("x-next-page") };
    },
    catch: (cause) => cause instanceof GitLabError ? cause : new GitLabError({ message: `GitLab ${method} ${path.split("?")[0]} request failed`, retryable: true, cause }),
  });
  const get = <A>(path: string, schema: z.ZodType<A>) => request(path, schema).pipe(Effect.retry(retry), Effect.map((response) => response.data));
  const pages = <A>(path: string, schema: z.ZodType<A>) => Effect.gen(function* () {
    const values: A[] = [];
    let page = "1";
    const seen = new Set<string>();
    while (page) {
      if (!/^\d+$/.test(page) || seen.has(page)) return yield* Effect.fail(new GitLabError({ message: "Invalid GitLab pagination" }));
      seen.add(page);
      const result = yield* request(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`, z.array(schema)).pipe(Effect.retry(retry));
      values.push(...result.data);
      if (result.next === null) return yield* Effect.fail(new GitLabError({ message: "GitLab pagination metadata is missing; completeness cannot be verified" }));
      page = result.next;
    }
    return values;
  });
  const text = (path: string) => request(path, z.string(), "GET", undefined, "text").pipe(Effect.retry(retry), Effect.map((response) => response.data));
  const write = <A>(path: string, schema: z.ZodType<A>, method: string, body: unknown) => request(path, schema, method, body).pipe(Effect.map((response) => response.data));
  return { get, pages, text, write };
};

// Binds the claim's token to one MR; callers never pass arbitrary request URLs.
const bindMr = (options: Options, scope: MrScope) => {
  const client = makeClient(options, scope.token);
  const project = `projects/${scope.projectId}`;
  const mr = `${project}/merge_requests/${scope.mrIid}`;
  const discussions = () => client.pages(`${mr}/discussions`, discussion);
  const ours = (authorId: number) => scope.botUserIds.includes(authorId);
  // GitLab creates a missing label when an MR is labelled, so labels are verified before the first label write of a claim.
  let labelsVisible = false;
  const ensureLabels = () => Effect.suspend(() => labelsVisible ? Effect.void : Effect.gen(function* () {
    const labels = yield* client.pages(`${project}/labels?include_ancestor_groups=true`, z.object({ name: z.string() }));
    const missing = Object.values(reviewLabels).find((name) => !labels.some((label) => label.name === name));
    if (missing) return yield* new LabelMissing({ message: `Required label ${missing} is missing; connect the project again in the FRED dashboard to create it` });
    labelsVisible = true;
  }));
  const publishDiscussion = (input: { marker: string; body: string; position?: Position }) => Effect.gen(function* () {
    const marker = publicationMarker(input.marker);
    const existing = (yield* discussions()).find((thread) => thread.notes.some((entry) => ours(entry.author.id) && entry.body.includes(marker)));
    if (existing) return { discussionId: existing.id, noteId: String(existing.notes[0]!.id) };
    const created = yield* client.write(`${mr}/discussions`, discussion, "POST", {
      body: `${input.body}\n\n${marker}`, ...(input.position ? { position: gitlabPosition(input.position) } : {}),
    });
    return { discussionId: created.id, noteId: String(created.notes[0]!.id) };
  }).pipe(Effect.retry(retry));
  // Reconciles a lost acknowledgement without writing, even after the MR head changes.
  const findSummary = (markerKey: string) => Effect.gen(function* () {
    const marker = publicationMarker(markerKey);
    const existing = (yield* client.pages(`${mr}/notes`, note)).find((entry) => ours(entry.author.id) && entry.body.includes(marker));
    return existing ? { noteId: String(existing.id) } : undefined;
  });
  const publishSummary = (input: { marker: string; body: string }) => Effect.gen(function* () {
    const existing = yield* findSummary(input.marker);
    if (existing) return existing;
    const created = yield* client.write(`${mr}/notes`, note, "POST", { body: `${input.body}\n\n${publicationMarker(input.marker)}` });
    return { noteId: String(created.id) };
  }).pipe(Effect.retry(retry));
  const resolveDiscussion = (input: { discussionId: string; marker: string; body: string; resolved?: boolean }) => Effect.gen(function* () {
    const path = `${mr}/discussions/${encodeURIComponent(input.discussionId)}`;
    const thread = yield* client.get(path, discussion);
    const first = thread.notes[0];
    if (!first || !ours(first.author.id) || !first.resolvable) return yield* Effect.fail(new GitLabError({ message: "Worker can only resolve its own resolvable discussions" }));
    const marker = publicationMarker(input.marker);
    if (!thread.notes.some((entry) => ours(entry.author.id) && entry.body.includes(marker))) yield* client.write(`${path}/notes`, note, "POST", { body: `${input.body}\n\n${marker}` });
    const resolved = input.resolved ?? true;
    if (Boolean(first.resolved) !== resolved) yield* client.write(path, discussion, "PUT", { resolved });
  }).pipe(Effect.retry(retry), Effect.asVoid);
  const setLabel = (verdict: ReviewVerdict) => Effect.gen(function* () {
    yield* ensureLabels();
    const remove = verdict === "clean" ? reviewLabels.findings : reviewLabels.clean;
    yield* client.write(mr, mergeRequest, "PUT", { add_labels: reviewLabels[verdict], remove_labels: remove }).pipe(Effect.retry(retry));
  });
  return { client, project, mr, discussions, operations: { ensureLabels, publishDiscussion, findSummary, publishSummary, resolveDiscussion, setLabel } };
};

// The MR writes a finding command publishes with, independent of the MR head.
export const makeGitLabMr = (options: Options, scope: MrScope) => bindMr(options, scope).operations;

// The MR writes plus the head-pinned reads of one review.
export const makeGitLabReview = (options: Options, scope: ReviewScope) => {
  const { client, project, mr, discussions, operations } = bindMr(options, scope);
  const tree = (projectPath: string, ref: string) => client.pages(`${projectPath}/repository/tree?recursive=true&ref=${encodeURIComponent(ref)}`, treeEntry).pipe(
    Effect.mapError((error) => error.status !== undefined || error.retryable === true ? error : incompleteMrDiff(error.message, [], error)),
  );
  const current = (value: z.infer<typeof mergeRequest>) => value.sha === scope.headSha && value.state === "opened";
  const isCurrent = () => client.get(mr, mergeRequest).pipe(Effect.map(current));
  // The verified review input at the claimed head, or undefined once the MR moved past it or closed.
  const loadContext = () => Effect.gen(function* () {
    const metadata = yield* client.get(mr, mergeRequest);
    if (!current(metadata)) return undefined;
    if (!metadata.diff_refs || metadata.diff_refs.head_sha !== scope.headSha) return yield* Effect.fail(new GitLabError({ message: "MR diff no longer matches the claimed commit" }));
    const refs = metadata.diff_refs;
    if (!metadata.source_project_id) return yield* Effect.fail(new GitLabError({ message: "MR source project is unavailable" }));
    const source = yield* client.get(`projects/${metadata.source_project_id}`, z.object({ http_url_to_repo: z.string().url() }));
    if (!plainHttpUrl(source.http_url_to_repo, options.baseUrl)) return yield* Effect.fail(new GitLabError({ message: "MR clone URL is outside the configured GitLab origin" }));
    const cloneUrl = new URL(source.http_url_to_repo).href;
    const apiDiff = yield* client.pages(`${mr}/diffs`, diff);
    const paths = (files: Diff[]) => formatPaths(files.map((file) => file.new_path));
    const lowerBound = cappedLowerBound(metadata.changes_count);
    if (lowerBound === undefined && (!metadata.changes_count || !/^\d+$/.test(metadata.changes_count) || Number(metadata.changes_count) !== apiDiff.length)) {
      return yield* Effect.fail(incompleteMrDiff(`expected ${metadata.changes_count ?? "unknown"} files, received ${apiDiff.length}`, apiDiff.map((file) => file.new_path)));
    }
    const omitted = apiDiff.filter(incompleteDiff);
    const fullDiff: ReviewFile[] = lowerBound === undefined && omitted.length === 0 ? apiDiff : yield* client.text(`${mr}/raw_diffs`).pipe(
      Effect.mapError((error) => new GitLabError({
        message: `Raw diff recovery failed for ${omitted.length ? paths(omitted) : "capped MR inventory"}: ${error.message}`,
        ...(error.status === undefined ? {} : { status: error.status }),
        cause: error,
      })),
      Effect.flatMap((raw) => lowerBound === undefined ? recoverDiff(apiDiff, raw) : Effect.gen(function* () {
        const base = yield* tree(project, refs.base_sha);
        const head = yield* tree(`projects/${metadata.source_project_id}`, scope.headSha);
        const files = yield* recoverCappedDiff(apiDiff, base, head, raw);
        if (files.length < lowerBound) return yield* Effect.fail(incompleteMrDiff("recovered file count is below GitLab's lower bound"));
        return files;
      })),
    );
    const hints = fullDiff.flatMap((file) => file.recovery?.hint ?? []);
    if (fullDiff.length > apiDiff.length) {
      hints.push("GitLab capped this MR's file list. Findings for files recovered beyond that list appear in the summary only.");
    }
    let reviewDiff = fullDiff;
    let reviewBaseSha = refs.base_sha;
    let unchangedSinceBaseline = false;
    const baseline = scope.previousReviewedSha;
    if (baseline && baseline !== scope.headSha) {
      // A straight comparison between two heads includes target-branch commits once the merge base moves, so a rebase or target merge gets a full review instead.
      const versions = yield* client.pages(`${mr}/versions`, diffVersion);
      const baselineVersion = versions.find((version) => version.head_commit_sha === baseline && version.base_commit_sha !== null);
      const delta = baselineVersion === undefined || baselineVersion.base_commit_sha !== refs.base_sha ? null
        : yield* client.get(`${project}/repository/compare?from=${encodeURIComponent(baseline)}&to=${encodeURIComponent(scope.headSha)}&straight=true`, comparison).pipe(
          Effect.catch((error) => error.status === 404 ? Effect.succeed(null) : Effect.fail(error)),
        );
      if (baselineVersion !== undefined && baselineVersion.base_commit_sha !== refs.base_sha) {
        hints.push("The merge base moved since the previous review, so the comparison would include target branch commits; this review covers the full MR.");
      } else if (delta === null || delta.compare_timeout || delta.overflow || delta.diffs.some(incompleteDiff)) {
        hints.push("The previous review baseline or complete incremental diff was unavailable; this review covers the full MR.");
      } else { reviewDiff = delta.diffs; reviewBaseSha = baseline; unchangedSinceBaseline = delta.diffs.length === 0; }
    } else if (baseline === scope.headSha) {
      hints.push("This commit was deliberately re-requested; this review covers the full MR again.");
    }
    const existing = yield* discussions();
    const after = yield* client.get(mr, mergeRequest);
    if (!current(after) || !sameDiffRefs(refs, after.diff_refs)) {
      return yield* Effect.fail(new GitLabError({ message: `MR changed while its review input was being loaded: claimed ${scope.headSha}, received ${after.sha}; head, state, or diff references changed; paths: ${paths(fullDiff)}` }));
    }
    const context: ReviewContext = { mrUrl: metadata.web_url, title: metadata.title, description: metadata.description ?? "", reviewBaseSha, diffRefs: refs, fullDiff, reviewDiff, discussions: existing, hints, cloneUrl, ...(unchangedSinceBaseline ? { unchangedSinceBaseline } : {}) };
    return context;
  });
  return { ...operations, isCurrent, loadContext };
};

export type GitLabMr = ReturnType<typeof makeGitLabMr>;
export type GitLabReview = ReturnType<typeof makeGitLabReview>;
export class GitLab extends Context.Service<GitLab, {
  forMr: (scope: MrScope) => GitLabMr;
  forReview: (scope: ReviewScope) => GitLabReview;
}>()("fred/GitLab") {}
export const GitLabLive = (options: Options) => Layer.succeed(GitLab, {
  forMr: (scope) => makeGitLabMr(options, scope),
  forReview: (scope) => makeGitLabReview(options, scope),
});
