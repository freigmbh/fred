import { failureSummary, publicationMarker } from "@fred/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import splitRename from "../../../../fixtures/gitlab/synthetic-split-rename.json";
import nonTextRenames from "../../../../fixtures/gitlab/synthetic-nontext-split-renames.json";
import omittedRename from "../../../../fixtures/gitlab/synthetic-omitted-split-rename.json";
import { classifyFailure } from "../diagnostics/failure";
import { positionFor } from "../reviewInput";
import { makeGitLabReview } from "./index";

// Bot 9 is the project's current FRED bot; bot 7 belonged to a token the project replaced.
const job = { projectId: 1, mrIid: 2, headSha: "a".repeat(40), botUserIds: [9, 7], token: "fixture-secret" };
const metadata = { web_url: "https://gitlab.internal/team/repo/-/merge_requests/2", title: "Change", description: null, sha: job.headSha, source_project_id: 1, diff_refs: { base_sha: "b".repeat(40), start_sha: "c".repeat(40), head_sha: job.headSha }, changes_count: "1", state: "opened" };
const change = { old_path: "old.ts", new_path: "new.ts", diff: "@@ -1,2 +1,2 @@\n context\n-old\n+new", new_file: false, renamed_file: true, deleted_file: false };
const rawChange = `diff --git a/old.ts b/new.ts\nsimilarity index 50%\nrename from old.ts\nrename to new.ts\nindex 1234567..abcdef0 100644\n--- a/old.ts\n+++ b/new.ts\n${change.diff}\n`;
const thread = (id: string, body: string, author = 9) => ({ id, notes: [{ id: 1, body, author: { id: author }, resolvable: true, resolved: false }] });
type Request = { url: URL; init: RequestInit | undefined };

const fixture = (respond: (request: Request) => Response) => {
  const requests: Request[] = [];
  const transport: typeof fetch = async (input, init) => {
    const request = { url: new URL(String(input)), init };
    requests.push(request);
    return respond(request);
  };
  return { requests, service: makeGitLabReview({ baseUrl: "https://gitlab.internal", fetch: transport }, job), transport };
};
const json = (value: unknown, next = "") => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json", "X-Next-Page": next } });
const contextResponse = ({ url }: Request) => {
  if (url.pathname.endsWith("/merge_requests/2")) return json(metadata);
  if (url.pathname.endsWith("/projects/1")) return json({ http_url_to_repo: "https://gitlab.internal/team/repo.git" });
  if (url.pathname.endsWith("/diffs")) return json([change]);
  if (url.pathname.endsWith("/discussions")) return json([]);
  if (url.pathname.endsWith("/versions")) return json([{ head_commit_sha: job.headSha, base_commit_sha: metadata.diff_refs.base_sha }]);
  return new Response(null, { status: 404 });
};
const baselineSha = "d".repeat(40);
const versions = (baseSha: string) => json([
  { head_commit_sha: job.headSha, base_commit_sha: metadata.diff_refs.base_sha },
  { head_commit_sha: baselineSha, base_commit_sha: baseSha },
]);

describe("GitLab review context", () => {
  it.each(nonTextRenames)("loads $kind split renames without inventing inline positions", async ({ deletion, addition }) => {
    const files = splitRename.diffs.map((entry) => entry.renamed_file ? { ...entry, diff: "", too_large: false, collapsed: false } : entry);
    const { transport } = fixture((request) => {
      if (request.url.pathname.endsWith("/merge_requests/2")) return json({ ...metadata, changes_count: "2" });
      if (request.url.pathname.endsWith("/diffs")) return json(files);
      if (request.url.pathname.endsWith("/raw_diffs")) return new Response(deletion + addition + splitRename.lockfile);
      return contextResponse(request);
    });
    const context = (await Effect.runPromise(makeGitLabReview({ baseUrl: "https://gitlab.internal", fetch: transport }, job).loadContext()))!;
    expect(context.fullDiff[0]).toEqual(files[0]);
    expect(context.fullDiff[1]?.diff).toBe("@@ -1 +1 @@\n-old\n+new\n");
    expect(positionFor(context, "new.ts", 1)).toBeUndefined();
    expect(positionFor(context, "old.ts", undefined, 1)).toBeUndefined();
    expect(positionFor(context, "lock.yaml", 1)).toMatchObject({ newLine: 1 });
  });

  it("stands in for an omitted split rename patch without inline positions", async () => {
    const { transport } = fixture((request) => {
      if (request.url.pathname.endsWith("/merge_requests/2")) return json({ ...metadata, changes_count: "2" });
      if (request.url.pathname.endsWith("/diffs")) return json(omittedRename.diffs);
      if (request.url.pathname.endsWith("/raw_diffs")) return new Response(omittedRename.deletion + omittedRename.addition + omittedRename.lockfile);
      return contextResponse(request);
    });
    const context = (await Effect.runPromise(makeGitLabReview({ baseUrl: "https://gitlab.internal", fetch: transport }, job).loadContext()))!;
    expect(context.hints).toEqual(['GitLab omitted the rename patch for `"old.ts"` to `"new.ts"`; its findings appear in the summary only.']);
    expect(positionFor(context, "new.ts", 2)).toBeUndefined();
    expect(positionFor(context, "old.ts", undefined, 1)).toBeUndefined();
    expect(positionFor(context, "lock.yaml", 1)).toMatchObject({ newLine: 1 });
    expect(context.fullDiff[0]?.recovery?.context).toMatch(/^GitLab omitted this rename's patch\./);
    expect(context.fullDiff[0]?.recovery?.context).toMatch(/\+changed\n\\ No newline at end of file$/);
  });

  it("renders a verified unchanged rename without an inline anchor", async () => {
    const rename = { ...change, diff: "" };
    const raw = "diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts\n";
    const { transport } = fixture((request) => {
      if (request.url.pathname.endsWith("/diffs")) return json([rename]);
      if (request.url.pathname.endsWith("/raw_diffs")) return new Response(raw);
      return contextResponse(request);
    });
    const context = (await Effect.runPromise(makeGitLabReview({ baseUrl: "https://gitlab.internal", fetch: transport }, job).loadContext()))!;
    expect(context.hints).toEqual([]);
    expect(context.fullDiff[0]?.recovery?.context).toBe(raw.slice(raw.indexOf("\n") + 1, -1));
    expect(positionFor(context, "new.ts", 1)).toBeUndefined();
  });

  it("recovers an omitted lockfile alongside a split rename", async () => {
    const { transport } = fixture((request) => {
      if (request.url.pathname.endsWith("/merge_requests/2")) return json({ ...metadata, changes_count: "2" });
      if (request.url.pathname.endsWith("/diffs")) return json(splitRename.diffs);
      if (request.url.pathname.endsWith("/raw_diffs")) return new Response(splitRename.deletion + splitRename.addition + splitRename.lockfile);
      return contextResponse(request);
    });
    const context = (await Effect.runPromise(makeGitLabReview({ baseUrl: "https://gitlab.internal", fetch: transport }, job).loadContext()))!;
    expect(context.fullDiff).toHaveLength(2);
    expect(context.fullDiff[0]).toEqual(splitRename.diffs[0]);
    expect(context.fullDiff[1]?.diff).toBe("@@ -1 +1 @@\n-old\n+new\n");
    expect(context.reviewDiff).toEqual(context.fullDiff);
    expect(positionFor(context, "new.ts", 1)).toEqual({
      baseSha: metadata.diff_refs.base_sha, startSha: metadata.diff_refs.start_sha, headSha: job.headSha,
      oldPath: "old.ts", newPath: "new.ts", oldLine: 1, newLine: 1,
    });
    expect(positionFor(context, "old.ts", undefined, 2)).toMatchObject({ oldPath: "old.ts", newPath: "new.ts", oldLine: 2 });
    expect(positionFor(context, "new.ts", 2)).toMatchObject({ oldPath: "old.ts", newPath: "new.ts", newLine: 2 });
    expect(positionFor(context, "lock.yaml", 1)).toMatchObject({ oldPath: "lock.yaml", newPath: "lock.yaml", newLine: 1 });
  });

  it.each(["http", "patch"])("distinguishes raw diff %s failures and keeps source out of the comment summary", async (failure) => {
    const { service } = fixture((request) => {
      if (request.url.pathname.endsWith("/diffs")) return json([{ ...change, diff: "" }]);
      if (request.url.pathname.endsWith("/raw_diffs")) return failure === "http" ? new Response(null, { status: 404 }) : new Response("PRIVATE_SOURCE\n");
      return contextResponse(request);
    });
    const error = await Effect.runPromise(service.loadContext().pipe(Effect.flip));
    const diagnostic = classifyFailure(error, []);
    expect(diagnostic).toEqual(failure === "http"
      ? { category: "gitlab", httpStatus: 404, detail: expect.stringContaining("/raw_diffs failed (404)") }
      : { category: "gitlab", code: "diff_recovery_failed", detail: expect.stringContaining("Raw diff") });
    expect(failureSummary(diagnostic)).toBe(failure === "http" ? "GitLab request failed (HTTP 404)" : "GitLab diff recovery failed; complete review input could not be verified");
  });

  it("falls back to the complete MR when the previous baseline is unavailable", async () => {
    const { transport } = fixture(contextResponse);
    const service = makeGitLabReview({ baseUrl: "https://gitlab.internal", fetch: transport }, { ...job, previousReviewedSha: baselineSha });
    const context = (await Effect.runPromise(service.loadContext()))!;
    expect(context.reviewDiff).toEqual(context.fullDiff);
    expect(context.hints).toEqual([expect.stringContaining("full MR")]);
  });

  it("reviews the full MR without comparing heads when the merge base moved since the previous review", async () => {
    const { transport, requests } = fixture((request) => request.url.pathname.endsWith("/versions") ? versions("e".repeat(40)) : contextResponse(request));
    const service = makeGitLabReview({ baseUrl: "https://gitlab.internal", fetch: transport }, { ...job, previousReviewedSha: baselineSha });
    const context = (await Effect.runPromise(service.loadContext()))!;
    expect(context.reviewDiff).toEqual(context.fullDiff);
    expect(context.reviewBaseSha).toBe(metadata.diff_refs.base_sha);
    expect(context.hints).toEqual([expect.stringContaining("merge base moved")]);
    expect(requests.some(({ url }) => url.pathname.endsWith("/repository/compare"))).toBe(false);
  });

  it("reports an unchanged head when the incremental comparison is empty", async () => {
    const { transport } = fixture((request) => {
      if (request.url.pathname.endsWith("/versions")) return versions(metadata.diff_refs.base_sha);
      if (request.url.pathname.endsWith("/repository/compare")) return json({ diffs: [], compare_timeout: false });
      return contextResponse(request);
    });
    const service = makeGitLabReview({ baseUrl: "https://gitlab.internal", fetch: transport }, { ...job, previousReviewedSha: baselineSha });
    const context = (await Effect.runPromise(service.loadContext()))!;
    expect(context).toMatchObject({ unchangedSinceBaseline: true, reviewDiff: [], reviewBaseSha: baselineSha, hints: [] });
  });

  it("skips GitLab's empty diff versions when finding the previous review's baseline", async () => {
    const { transport } = fixture((request) => {
      if (request.url.pathname.endsWith("/versions")) return json([
        { head_commit_sha: job.headSha, base_commit_sha: metadata.diff_refs.base_sha },
        { head_commit_sha: baselineSha, base_commit_sha: null },
        { head_commit_sha: baselineSha, base_commit_sha: metadata.diff_refs.base_sha },
      ]);
      if (request.url.pathname.endsWith("/repository/compare")) return json({ diffs: [], compare_timeout: false });
      return contextResponse(request);
    });
    const service = makeGitLabReview({ baseUrl: "https://gitlab.internal", fetch: transport }, { ...job, previousReviewedSha: baselineSha });
    const context = (await Effect.runPromise(service.loadContext()))!;
    expect(context).toMatchObject({ unchangedSinceBaseline: true, reviewBaseSha: baselineSha, hints: [] });
  });

  it("reviews the full MR again after a deliberate same-commit re-request", async () => {
    const { transport } = fixture(contextResponse);
    const service = makeGitLabReview({ baseUrl: "https://gitlab.internal", fetch: transport }, { ...job, previousReviewedSha: job.headSha });
    const context = (await Effect.runPromise(service.loadContext()))!;
    expect(context.reviewDiff).toEqual([change]);
    expect(context.reviewBaseSha).toBe(metadata.diff_refs.base_sha);
    expect(context.hints).toEqual([expect.stringContaining("full MR again")]);
  });

  it("rejects an exact file count that reveals a truncated full diff", async () => {
    const { service } = fixture((request) => request.url.pathname.endsWith("/merge_requests/2") ? json({ ...metadata, changes_count: "2" }) : contextResponse(request));
    await expect(Effect.runPromise(service.loadContext())).rejects.toMatchObject({ _tag: "GitLabError", diagnostic: { code: "diff_recovery_failed" } });
  });

  it("rejects an omitted file body even when file counts match", async () => {
    const { service } = fixture((request) => request.url.pathname.endsWith("/diffs") ? json([{ ...change, too_large: true }]) : contextResponse(request));
    await expect(Effect.runPromise(service.loadContext())).rejects.toMatchObject({ _tag: "GitLabError" });
  });

  it("rejects an ambiguous empty diff when raw recovery is unavailable", async () => {
    const { service } = fixture((request) => request.url.pathname.endsWith("/diffs") ? json([{ ...change, diff: "" }]) : contextResponse(request));
    await expect(Effect.runPromise(service.loadContext())).rejects.toMatchObject({ _tag: "GitLabError", message: expect.stringContaining('Raw diff recovery failed for `"new.ts"`') });
  });

  it("recovers omitted patches and preserves inline positions", async () => {
    const { transport, requests } = fixture((request) => {
      if (request.url.pathname.endsWith("/diffs")) return json([{ ...change, diff: "" }]);
      if (request.url.pathname.endsWith("/raw_diffs")) return new Response(rawChange);
      return contextResponse(request);
    });
    const service = makeGitLabReview({ baseUrl: "https://gitlab.internal", fetch: transport }, job);
    const context = (await Effect.runPromise(service.loadContext()))!;
    expect(context.fullDiff[0]).toEqual({ ...change, diff: `${change.diff}\n`, too_large: false, collapsed: false });
    expect(context.reviewDiff).toEqual(context.fullDiff);
    expect(positionFor(context, "new.ts", 2)).toEqual({
      baseSha: metadata.diff_refs.base_sha, startSha: metadata.diff_refs.start_sha, headSha: job.headSha,
      oldPath: "old.ts", newPath: "new.ts", newLine: 2,
    });
    expect(positionFor(context, "old.ts", undefined, 2)).toMatchObject({ oldLine: 2 });
    expect(requests.filter(({ url }) => url.pathname.endsWith("/raw_diffs"))).toHaveLength(1);
    expect(requests.every(({ init }) => init?.method === "GET" && init.redirect === "error")).toBe(true);
  });

  it("leaves complete API patches on the regular path", async () => {
    const { service, requests } = fixture(contextResponse);
    expect((await Effect.runPromise(service.loadContext()))?.fullDiff).toEqual([change]);
    expect(requests.some(({ url }) => url.pathname.endsWith("/raw_diffs"))).toBe(false);
  });

  it.each([
    ["missing", "", "malformed file section"],
    ["truncated", rawChange.replace("+new\n", ""), "incomplete or malformed hunks"],
    ["duplicated", rawChange + rawChange, "duplicate file section"],
    ["wrong path", rawChange.replaceAll("new.ts", "other.ts"), "unexpected or malformed file section"],
  ])("rejects %s raw recovery with the affected path", async (_name, raw, condition) => {
    const { service } = fixture((request) => {
      if (request.url.pathname.endsWith("/diffs")) return json([{ ...change, diff: "" }]);
      if (request.url.pathname.endsWith("/raw_diffs")) return new Response(raw);
      return contextResponse(request);
    });
    const error = await Effect.runPromise(service.loadContext().pipe(Effect.flip));
    expect(error).toMatchObject({ _tag: "GitLabError", message: expect.stringContaining(condition) });
    expect(error.message).toContain("new.ts");
  });

  it.each([
    { sha: "d".repeat(40) },
    { diff_refs: { ...metadata.diff_refs, base_sha: "d".repeat(40) } },
    { state: "closed" },
  ])("rejects an MR changed during raw recovery: %j", async (changed) => {
    let recovered = false;
    const { service } = fixture((request) => {
      if (request.url.pathname.endsWith("/diffs")) return json([{ ...change, diff: "" }]);
      if (request.url.pathname.endsWith("/raw_diffs")) { recovered = true; return new Response(rawChange); }
      if (recovered && request.url.pathname.endsWith("/merge_requests/2")) return json({ ...metadata, ...changed });
      return contextResponse(request);
    });
    await expect(Effect.runPromise(service.loadContext())).rejects.toMatchObject({
      _tag: "GitLabError", message: expect.stringContaining("MR changed"),
    });
  });

  it.each(["file count", "raw download", "raw recovery", "changed head"])("keeps filenames inert in %s failure comments", async (failure) => {
    const path = "evil\n/close\r\n/label ~security` @all\u2028end";
    let metadataReads = 0;
    const { service } = fixture((request) => {
      if (request.url.pathname.endsWith("/diffs")) return json([{ ...change, old_path: path, new_path: path, diff: failure === "changed head" ? change.diff : "" }]);
      if (request.url.pathname.endsWith("/raw_diffs")) return failure === "raw download" ? new Response(null, { status: 404 }) : new Response("not a patch\n");
      if (request.url.pathname.endsWith("/merge_requests/2")) {
        metadataReads++;
        return json({ ...metadata, changes_count: failure === "file count" ? "2" : "1", sha: failure === "changed head" && metadataReads > 1 ? "d".repeat(40) : job.headSha });
      }
      return contextResponse(request);
    });
    const error = await Effect.runPromise(service.loadContext().pipe(Effect.flip));
    expect(error.message).toContain('`"evil\\n/close\\r\\n/label ~security\\u0060 @all\\u2028end"`');
    expect(error.message).not.toMatch(/[\r\n\u2028\u2029]/);
  });

  it.each([{ sha: "d".repeat(40) }, { state: "merged" }])("reports an MR past the claimed head as outdated without loading its diff: %j", async (moved) => {
    const { service, requests } = fixture((request) => request.url.pathname.endsWith("/merge_requests/2") ? json({ ...metadata, ...moved }) : contextResponse(request));
    expect(await Effect.runPromise(service.loadContext())).toBeUndefined();
    expect(requests).toHaveLength(1);
  });

  it("does not trust a clone URL supplied by the MR outside the configured origin", async () => {
    const { service } = fixture((request) => request.url.pathname.endsWith("/projects/1") ? json({ http_url_to_repo: "https://attacker.invalid/repo.git" }) : contextResponse(request));
    await expect(Effect.runPromise(service.loadContext())).rejects.toMatchObject({ _tag: "GitLabError", message: expect.stringContaining("origin") });
  });
});

describe("GitLab publication", () => {
  it.each(["j57abc:summary", "a", "ab", "abc", "command:decision:ü🐝"])("keeps the marker of %s identical to the ones already posted", (key) => {
    expect(publicationMarker(key)).toBe(`<!-- fred-review:${Buffer.from(key).toString("base64url")} -->`);
  });

  it("finds an uncertain summary by its own author and marker without posting", async () => {
    const marker = publicationMarker("job:summary");
    const { service, requests } = fixture(({ url }) => url.searchParams.get("page") === "1"
      ? json([{ id: 1, body: marker, author: { id: 123 } }], "2")
      : json([{ id: 2, body: marker, author: { id: 9 } }]));
    expect(await Effect.runPromise(service.findSummary("job:summary"))).toEqual({ noteId: "2" });
    expect(requests.map(({ init }) => init?.method)).toEqual(["GET", "GET"]);
  });

  it("reconciles a summary its former bot posted instead of posting a duplicate", async () => {
    const marker = publicationMarker("job:summary");
    const { service, requests } = fixture(() => json([{ id: 3, body: `Summary\n\n${marker}`, author: { id: 7 } }]));
    expect(await Effect.runPromise(service.publishSummary({ marker: "job:summary", body: "Summary" }))).toEqual({ noteId: "3" });
    expect(requests.map(({ init }) => init?.method)).toEqual(["GET"]);
  });

  it("reconciles its marker across every page and ignores a marker copied by another author", async () => {
    const marker = publicationMarker("job:effect");
    const { service, requests } = fixture(({ url }) => url.searchParams.get("page") === "1" ? json([thread("forged", marker, 123)], "2") : json([thread("own", marker)]));
    expect(await Effect.runPromise(service.publishDiscussion({ marker: "job:effect", body: "Finding" }))).toEqual({ discussionId: "own", noteId: "1" });
    expect(requests).toHaveLength(2);
    expect(requests.every(({ init }) => init?.method === "GET" && init.redirect === "error")).toBe(true);
  });

  it("fails incomplete discussion pagination instead of posting a possible duplicate", async () => {
    const { service, requests } = fixture(() => new Response("[]", { headers: { "Content-Type": "application/json" } }));
    await expect(Effect.runPromise(service.publishDiscussion({ marker: "job:effect", body: "Finding" }))).rejects.toMatchObject({ _tag: "GitLabError" });
    expect(requests).toHaveLength(1);
  });

  it("cannot resolve a thread authored outside the project's FRED bots", async () => {
    const { service, requests } = fixture(() => json(thread("human", "Human finding", 123)));
    await expect(Effect.runPromise(service.resolveDiscussion({ discussionId: "human", marker: "resolve", body: "Fixed" }))).rejects.toMatchObject({ _tag: "GitLabError" });
    expect(requests).toHaveLength(1);
  });

  it("resolves a discussion its former bot opened, replying as the current bot", async () => {
    const { service, requests } = fixture(({ init }) => json(init?.method === "POST" ? { id: 2, body: "Fixed", author: { id: 9 } } : thread("former", "Finding", 7)));
    await Effect.runPromise(service.resolveDiscussion({ discussionId: "former", marker: "resolve", body: "Fixed" }));
    expect(requests.map(({ init }) => init?.method)).toEqual(["GET", "POST", "PUT"]);
  });

  it("recovers a posted resolution reply without posting it again", async () => {
    const existing = thread("own", publicationMarker("resolve"));
    const { service, requests } = fixture(() => json(existing));
    await Effect.runPromise(service.resolveDiscussion({ discussionId: "own", marker: "resolve", body: "Fixed" }));
    expect(requests.map(({ init }) => init?.method)).toEqual(["GET", "PUT"]);
  });

  it.each(["project", "group"])("sets an existing %s label without creating labels", async (kind) => {
    const labels = ["clean", "findings"].map((suffix) => ({ name: `fred-review::${suffix}`, is_project_label: kind === "project" }));
    const { service, requests } = fixture(({ url }) => url.pathname.endsWith("/labels") ? json(labels) : json(metadata));
    await Effect.runPromise(service.setLabel("clean"));
    expect(requests.map(({ url, init }) => `${init?.method} ${url.pathname}`)).toEqual([
      "GET /api/v4/projects/1/labels", "PUT /api/v4/projects/1/merge_requests/2",
    ]);
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({ add_labels: "fred-review::clean", remove_labels: "fred-review::findings" });
  });

  it("verifies the labels once per claim", async () => {
    const labels = ["clean", "findings"].map((suffix) => ({ name: `fred-review::${suffix}` }));
    const { service, requests } = fixture(({ url }) => url.pathname.endsWith("/labels") ? json(labels) : json(metadata));
    await Effect.runPromise(service.ensureLabels().pipe(Effect.andThen(service.setLabel("findings"))));
    expect(requests.filter(({ url }) => url.pathname.endsWith("/labels"))).toHaveLength(1);
  });

  it("fails a missing label without creating it or labelling the MR", async () => {
    const { service, requests } = fixture(() => json([{ name: "fred-review::clean", is_project_label: true }, { name: "codex-review::findings", is_project_label: false }]));
    await expect(Effect.runPromise(service.setLabel("clean"))).rejects.toMatchObject({ _tag: "LabelMissing" });
    expect(requests.every(({ init }) => init?.method === "GET")).toBe(true);
  });
});

describe("diff positions", () => {
  const context = { fullDiff: [change], diffRefs: metadata.diff_refs };
  it("anchors new and deleted lines and includes both coordinates for context", () => {
    expect(positionFor(context, "new.ts", 2)).toMatchObject({ newLine: 2 });
    expect(positionFor(context, "old.ts", undefined, 2)).toMatchObject({ oldLine: 2 });
    expect(positionFor(context, "new.ts", 1)).toMatchObject({ oldLine: 1, newLine: 1 });
    expect(positionFor(context, "new.ts", 999)).toBeUndefined();
  });
});
