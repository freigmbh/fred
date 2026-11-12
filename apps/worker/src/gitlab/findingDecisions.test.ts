import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { publicationMarker } from "@fred/contracts";
import { makeGitLabMr } from "./index";

const scope = { projectId: 1, mrIid: 2, botUserIds: [9], token: "fixture-token" };
const input = { discussionId: "finding-thread", marker: "command-1:decision", body: "Finding reopened.", resolved: false };
const originalNote = { id: 10, body: "Original finding", author: { id: 9 }, resolvable: true, resolved: true };
const decisionNote = (author: number) => ({ id: 11, body: publicationMarker(input.marker), author: { id: author } });
const json = (value: unknown) => Response.json(value);

function transport(notes: (typeof originalNote | ReturnType<typeof decisionNote>)[]) {
  const requests: { method: string; pathname: string; body: unknown }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const method = init?.method ?? "GET";
    const pathname = new URL(String(url)).pathname;
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ method, pathname, body });
    if (pathname.endsWith("/discussions/finding-thread")) return json({ id: "finding-thread", notes });
    if (method === "POST" && pathname.endsWith("/discussions/finding-thread/notes")) return json(decisionNote(9));
    throw new Error(`Unexpected request: ${method} ${pathname}`);
  };
  return { requests, service: makeGitLabMr({ baseUrl: "https://gitlab.internal", fetch: fetcher }, scope) };
}

describe("GitLab human finding decisions", () => {
  it("posts an undo explanation and sends resolved false", async () => {
    const test = transport([originalNote]);
    await Effect.runPromise(test.service.resolveDiscussion(input));
    expect(test.requests).toEqual([
      { method: "GET", pathname: "/api/v4/projects/1/merge_requests/2/discussions/finding-thread", body: undefined },
      { method: "POST", pathname: "/api/v4/projects/1/merge_requests/2/discussions/finding-thread/notes",
        body: { body: `Finding reopened.\n\n${publicationMarker(input.marker)}` } },
      { method: "PUT", pathname: "/api/v4/projects/1/merge_requests/2/discussions/finding-thread", body: { resolved: false } },
    ]);
  });

  it("recovers an existing own-bot reply and reopens the thread without duplicating its explanation", async () => {
    const test = transport([originalNote, decisionNote(9)]);
    await Effect.runPromise(test.service.resolveDiscussion(input));
    expect(test.requests.map(({ method }) => method)).toEqual(["GET", "PUT"]);
    expect(test.requests[1]?.body).toEqual({ resolved: false });
  });

  it("does not treat a human-copied marker as its own published decision", async () => {
    const test = transport([originalNote, decisionNote(42)]);
    await Effect.runPromise(test.service.resolveDiscussion(input));
    expect(test.requests.map(({ method }) => method)).toEqual(["GET", "POST", "PUT"]);
  });

  it("cannot reopen another author's discussion even when it contains an own-bot decision reply", async () => {
    const test = transport([{ ...originalNote, author: { id: 42 } }, decisionNote(9)]);
    await expect(Effect.runPromise(test.service.resolveDiscussion(input))).rejects.toMatchObject({ _tag: "GitLabError" });
    expect(test.requests.map(({ method }) => method)).toEqual(["GET"]);
  });
});
