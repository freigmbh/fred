import { failureSummary } from "@fred/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { classifyFailure } from "../diagnostics/failure";
import { buildResult } from "../result";
import { recoverCappedDiff } from "./cappedDiff";
import { positionFor } from "../reviewInput";
import { makeGitLabReview, type ReviewScope } from "./index";

const job: ReviewScope = { projectId: 1, mrIid: 2, headSha: "a".repeat(40), botUserIds: [9], token: "fixture-secret" };
const metadata = { web_url: "https://gitlab.internal/team/repo/-/merge_requests/2", title: "Change", description: null, sha: job.headSha, source_project_id: 3, diff_refs: { base_sha: "b".repeat(40), start_sha: "c".repeat(40), head_sha: job.headSha }, changes_count: "1+", state: "opened" };
const entry = (path: string, id: string, mode = "100644") => ({ path, id, mode, type: "blob" as const });
const patch = "@@ -1 +1 @@\n-old\n+new\n";
const file = { old_path: "known.ts", new_path: "known.ts", diff: patch, new_file: false, renamed_file: false, deleted_file: false };
const rawFile = (path: string) => `diff --git a/${path} b/${path}\nindex 1234567..abcdef0 100644\n--- a/${path}\n+++ b/${path}\n${patch}`;
const base = [entry("known.ts", "1234567"), entry("missing.ts", "1234567")];
const head = base.map((file) => ({ ...file, id: "abcdef0" }));
const raw = rawFile("known.ts") + rawFile("missing.ts");
const json = (value: unknown, next = "") => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json", "X-Next-Page": next } });

const fixture = (override: (url: URL) => Response | undefined = () => undefined) => {
  const requests: URL[] = [];
  const transport: typeof fetch = async (input) => {
    const url = new URL(String(input));
    requests.push(url);
    const response = override(url);
    if (response) return response;
    if (url.pathname.endsWith("/merge_requests/2")) return json(metadata);
    if (url.pathname.endsWith("/projects/3")) return json({ http_url_to_repo: "https://gitlab.internal/team/fork.git" });
    if (url.pathname.endsWith("/diffs")) return json([file]);
    if (url.pathname.endsWith("/raw_diffs")) return new Response(raw);
    if (url.pathname.endsWith("/repository/tree")) return json(url.searchParams.get("ref") === metadata.diff_refs.base_sha ? base : head);
    if (url.pathname.endsWith("/discussions")) return json([]);
    return new Response(null, { status: 404 });
  };
  return { requests, service: makeGitLabReview({ baseUrl: "https://gitlab.internal", fetch: transport }, job) };
};

describe("capped MR diffs", () => {
  it("recovers files missing from the API, retaining only known inline positions", async () => {
    const { service, requests } = fixture((url) => {
      if (!url.pathname.endsWith("/repository/tree")) return;
      const entries = url.searchParams.get("ref") === metadata.diff_refs.base_sha ? base : head;
      return url.searchParams.get("page") === "1" ? json(entries.slice(0, 1), "2") : json(entries.slice(1));
    });
    const context = (await Effect.runPromise(service.loadContext()))!;
    expect(context.fullDiff[0]).toEqual(file);
    expect(context.fullDiff[1]).toMatchObject({ new_path: "missing.ts", recovery: { context: patch } });
    expect(positionFor(context, "known.ts", 1)).toMatchObject({ newLine: 1 });
    expect(positionFor(context, "missing.ts", 1)).toBeUndefined();
    const hint = "GitLab capped this MR's file list. Findings for files recovered beyond that list appear in the summary only.";
    expect(context.hints).toEqual([hint]);
    const result = await Effect.runPromise(buildResult({
      jobId: "fixture-job", botUserIds: job.botUserIds, context, hints: context.hints, previous: [],
      candidates: [{ file: "missing.ts", line: 1, severity: "should_fix", title: "Recovered finding", body: "A finding in a file omitted from the API." }],
      validation: { verdicts: [{ index: 0, verdict: "accepted" }], findingDecisions: [] },
    }));
    expect(result.effects.map((effect) => effect.kind)).toEqual(["summary", "label"]);
    expect(result.effects[0]).toMatchObject({ body: expect.stringContaining(`Note: ${hint}`), findingIndexes: [0] });
    const trees = requests.filter((url) => url.pathname.endsWith("/repository/tree"));
    expect(trees.map((url) => [url.pathname, url.searchParams.get("ref"), url.searchParams.get("page"), url.searchParams.get("recursive")])).toEqual([
      ["/api/v4/projects/1/repository/tree", metadata.diff_refs.base_sha, "1", "true"],
      ["/api/v4/projects/1/repository/tree", metadata.diff_refs.base_sha, "2", "true"],
      ["/api/v4/projects/3/repository/tree", job.headSha, "1", "true"],
      ["/api/v4/projects/3/repository/tree", job.headSha, "2", "true"],
    ]);
  });

  it.each([rawFile("known.ts"), raw.slice(0, -5)])("rejects a raw diff truncated at a file boundary or inside a hunk", async (truncated) => {
    const { service } = fixture((url) => url.pathname.endsWith("/raw_diffs") ? new Response(truncated) : undefined);
    const error = await Effect.runPromise(service.loadContext().pipe(Effect.flip));
    expect(classifyFailure(error, [])).toEqual({ category: "gitlab", code: "diff_recovery_failed", detail: expect.stringContaining("GitLabError") });
    expect(failureSummary(classifyFailure(error, []))).toBe("GitLab diff recovery failed; complete review input could not be verified");
  });

  it.each([undefined, "invalid", "1"])("classifies incomplete tree pagination as diff recovery: %s", async (next) => {
    const { service } = fixture((url) => url.pathname.endsWith("/repository/tree")
      ? new Response(JSON.stringify(base), { headers: next === undefined ? {} : { "X-Next-Page": next } }) : undefined);
    const error = await Effect.runPromise(service.loadContext().pipe(Effect.flip));
    expect(error.message).toContain("pagination");
    expect(classifyFailure(error, [])).toEqual({ category: "gitlab", code: "diff_recovery_failed", detail: expect.stringContaining("GitLabError") });
    expect(failureSummary(classifyFailure(error, []))).toBe("GitLab diff recovery failed; complete review input could not be verified");
  });

  it.each([{ sha: "d".repeat(40) }, { diff_refs: { ...metadata.diff_refs, base_sha: "d".repeat(40) } }, { state: "closed" }])("rejects an MR changed during recovery: %j", async (changed) => {
    let metadataReads = 0;
    const { service } = fixture((url) => url.pathname.endsWith("/merge_requests/2") ? json(++metadataReads > 1 ? { ...metadata, ...changed } : metadata) : undefined);
    await expect(Effect.runPromise(service.loadContext())).rejects.toMatchObject({ message: expect.stringContaining("MR changed") });
  });

  it("rejects a recovered inventory below the reported lower bound", async () => {
    const { service } = fixture((url) => url.pathname.endsWith("/merge_requests/2") ? json({ ...metadata, changes_count: "3+" }) : undefined);
    await expect(Effect.runPromise(service.loadContext())).rejects.toMatchObject({ diagnostic: { code: "diff_recovery_failed" } });
  });

  it("preserves HTTP failure classification during capped recovery", async () => {
    const { service } = fixture((url) => url.pathname.endsWith("/repository/tree") ? new Response(null, { status: 403 }) : undefined);
    const error = await Effect.runPromise(service.loadContext().pipe(Effect.flip));
    expect(classifyFailure(error, [])).toEqual({ category: "gitlab", httpStatus: 403, detail: expect.stringContaining("/repository/tree failed (403)") });
  });

  it("identifies the capped inventory when raw download fails without any omitted API patches", async () => {
    const { service } = fixture((url) => url.pathname.endsWith("/raw_diffs") ? new Response('{"message":"403 Forbidden by policy"}', { status: 403 }) : undefined);
    const error = await Effect.runPromise(service.loadContext().pipe(Effect.flip));
    expect(error.message).toBe("Raw diff recovery failed for capped MR inventory: GitLab GET /api/v4/projects/1/merge_requests/2/raw_diffs failed (403)");
    expect(classifyFailure(error, [])).toEqual({ category: "gitlab", httpStatus: 403, detail: expect.stringContaining('body {"message":"403 Forbidden by policy"}') });
  });

  it("keeps the schema mismatch of an invalid tree response in the recovery failure detail", async () => {
    const { service } = fixture((url) => url.pathname.endsWith("/repository/tree") ? json([{ unexpected: true }]) : undefined);
    const error = await Effect.runPromise(service.loadContext().pipe(Effect.flip));
    expect(classifyFailure(error, [])).toEqual({ category: "gitlab", code: "diff_recovery_failed",
      detail: expect.stringMatching(/returned an invalid response; body .+/) });
  });

  it("recovers a missing quoted rename and an empty addition as summary context", async () => {
    const rename = 'diff --git "a/old\\tname" "b/new\\tname"\nsimilarity index 100%\nrename from "old\\tname"\nrename to "new\\tname"\n';
    const empty = "diff --git a/empty b/empty\nnew file mode 100644\nindex 0000000..e69de29\n";
    const files = await Effect.runPromise(recoverCappedDiff([], [entry("old\tname", "1234567")], [entry("new\tname", "1234567"), entry("empty", "e69de29")], rename + empty));
    expect(files.map((file) => [file.old_path, file.new_path, file.renamed_file, file.new_file, Boolean(file.recovery)])).toEqual([
      ["old\tname", "new\tname", true, false, true], ["empty", "empty", false, true, true],
    ]);
  });

  it("detects an omitted mode-only change even when blob IDs match", async () => {
    const result = recoverCappedDiff([], [entry("script", "1234567")], [entry("script", "1234567", "100755")], "");
    await expect(Effect.runPromise(result)).rejects.toMatchObject({ diagnostic: { code: "diff_recovery_failed" } });
  });

  it.each([
    { duplicate: "tree", apiFiles: [file], baseEntries: [...base, base[0]!] },
    { duplicate: "api", apiFiles: [file, file], baseEntries: base },
  ])("rejects duplicate $duplicate entries", async ({ apiFiles, baseEntries }) => {
    const result = recoverCappedDiff(apiFiles, baseEntries, head, raw);
    await expect(Effect.runPromise(result)).rejects.toMatchObject({ diagnostic: { code: "diff_recovery_failed" } });
  });
});
