import { decisionPublication } from "@fred/contracts";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import type { Id } from "../../controller/convex/_generated/dataModel";
import { Controller, type ClaimedCommand, type CommandControl, type PreviousFinding } from "./controller";
import { ControllerError, GitLabError } from "./errors";
import { GitLab, type GitLabMr, type MrScope } from "./gitlab";
import { runFindingCommand } from "./runFindingCommand";
import { fixtureConfig, fixtureJob, testServices } from "./testLayers";

const command: ClaimedCommand = {
  kind: "finding_command", _id: "command-1" as Id<"findingCommands">, _creationTime: 1,
  projectId: fixtureJob.projectId, mrIid: 1, provider: "fred", noteId: "human-note", actorId: "42",
  action: "dismiss", findingId: "finding-1" as Id<"findings">, expectedDecisionRef: null,
  reason: "The empty input is intentional.", status: "running", publicationAcks: [],
  workerId: "fixture-worker", leaseToken: "command-lease", leaseGeneration: 1, leaseExpiresAt: 200_000,
  gitlabProjectId: "1", gitlabBotUserId: "3", gitlabBotUserIds: ["2", "3"], gitlabToken: "fixture-token",
};
const publication = decisionPublication.parse({ body: "Finding dismissed by GitLab user 42.", resolved: true, label: "clean" });

function services(result = publication) {
  const review = testServices();
  const calls: string[] = [];
  const failures: string[] = [];
  const bindings: MrScope[] = [];
  const summaries: Parameters<GitLabMr["publishSummary"]>[0][] = [];
  const resolutions: Parameters<GitLabMr["resolveDiscussion"]>[0][] = [];
  const control = {
    heartbeat: () => Effect.succeed({ leaseExpiresAt: 200_000 }),
    context: () => Effect.sync(() => { calls.push("context"); return []; }),
    reconcileSummary: () => Effect.sync(() => { calls.push("reconcile"); return null; }),
    prepare: () => Effect.sync(() => { calls.push("prepare"); return JSON.stringify(result); }),
    acknowledge: (effect: "decision" | "label") => Effect.sync(() => { calls.push(`ack:${effect}`); return null; }),
    fail: (message: string) => Effect.sync(() => { failures.push(message); calls.push("fail"); return null; }),
  } satisfies CommandControl;
  const gitlab = {
    ...review.gitlab,
    publishSummary: (input: Parameters<GitLabMr["publishSummary"]>[0]) => Effect.sync(() => {
      calls.push("summary"); summaries.push(input); return { noteId: "decision-note" };
    }),
    resolveDiscussion: (input: Parameters<GitLabMr["resolveDiscussion"]>[0]) => Effect.sync(() => {
      calls.push("resolve"); resolutions.push(input); return undefined;
    }),
    setLabel: (label: "clean" | "findings") => Effect.sync(() => { calls.push(`label:${label}`); }),
  } satisfies GitLabMr;
  const run = (work = command, overrides: { control?: Partial<CommandControl>; gitlab?: Partial<GitLabMr> } = {}) =>
    Effect.runPromise(runFindingCommand(work).pipe(Effect.provide(Layer.mergeAll(
      fixtureConfig,
      Layer.succeed(Controller, { ...review.controller, forCommand: () => ({ ...control, ...overrides.control }) }),
      Layer.succeed(GitLab, { forReview: () => { throw new Error("A finding command has no review scope"); }, forMr: (scope) => { bindings.push(scope); return { ...gitlab, ...overrides.gitlab }; } }),
    ))));
  return { run, calls, failures, bindings, summaries, resolutions };
}

describe("human finding decision publication", () => {
  it("publishes a summary-only dismissal with the claim's project token without a provider or checkout", async () => {
    const test = services();
    await test.run();
    expect(test.calls).toEqual(["context", "prepare", "summary", "ack:decision", "label:clean", "ack:label"]);
    expect(test.summaries).toEqual([{ marker: "command-1:decision", body: publication.body }]);
    expect(test.resolutions).toEqual([]);
    expect(test.bindings).toEqual([{ projectId: 1, mrIid: 1, botUserIds: [3, 2], token: "fixture-token" }]);
    expect(test.failures).toEqual([]);
  });

  it("reopens the stored discussion for undo before restoring the findings label", async () => {
    const reopened = { ...publication, body: "Finding reopened by GitLab user 42.", discussionId: "discussion-1", resolved: false, label: "findings" as const };
    const test = services(reopened);
    await test.run({ ...command, action: "undo", expectedDecisionRef: "decision-1" });
    expect(test.resolutions).toEqual([{ marker: "command-1:decision", body: reopened.body, discussionId: "discussion-1", resolved: false }]);
    expect(test.calls).toEqual(["context", "prepare", "resolve", "ack:decision", "label:findings", "ack:label"]);
    expect(test.summaries).toEqual([]);
  });

  it("resumes only the unacknowledged label from the immutable saved publication", async () => {
    const test = services();
    await test.run({ ...command, status: "publishing", resultJson: JSON.stringify(publication), publicationAcks: ["decision"] });
    expect(test.calls).toEqual(["label:clean", "ack:label"]);
    expect(test.summaries).toEqual([]);
    expect(test.resolutions).toEqual([]);
  });

  it("reports a failed decision write and retries its stable marker before changing the label", async () => {
    const test = services();
    const saved = { ...command, status: "publishing" as const, resultJson: JSON.stringify(publication) };
    const attempted: string[] = [];
    await test.run(saved, { gitlab: { publishSummary: (input) => Effect.sync(() => { attempted.push(input.marker); }).pipe(
      Effect.andThen(Effect.fail(new GitLabError({ message: "Private GitLab response", status: 403 }))),
    ) } });
    expect(test.calls).toEqual(["fail"]);
    expect(test.failures).toEqual(["GitLab request failed (HTTP 403)"]);
    await test.run(saved);
    expect(test.summaries.map((input) => input.marker)).toEqual(attempted);
    expect(test.calls).toEqual(["fail", "summary", "ack:decision", "label:clean", "ack:label"]);
  });

  it("stops before GitLab writes when its controller lease is lost", async () => {
    const test = services();
    await test.run({ ...command, resultJson: JSON.stringify(publication) }, {
      control: { heartbeat: () => Effect.fail(new ControllerError({ message: "lease lost" })) },
    });
    expect(test.calls).toEqual(["fail"]);
    expect(test.failures).toEqual(["Controller communication or job ownership failed"]);
    expect(test.summaries).toEqual([]);
  });

  it("rejects a non-fixture project before constructing its GitLab adapter or preparing a decision", async () => {
    const test = services();
    await test.run({ ...command, gitlabProjectId: "99" });
    expect(test.calls).toEqual(["fail"]);
    expect(test.bindings).toEqual([]);
    expect(test.failures).toEqual(["Runtime configuration is invalid"]);
  });

  it("does not publish or relabel a command the controller rejects during preparation", async () => {
    const test = services();
    await test.run(command, { control: { prepare: () => Effect.succeed(null) } });
    expect(test.calls).toEqual(["context"]);
    expect(test.failures).toEqual([]);
    expect(test.summaries).toEqual([]);
  });

  it("reconciles summaries only for findings that could have been published", async () => {
    const test = services();
    const statuses = ["pending", "posted", "rejected", "duplicate"] as const;
    const previous = statuses.map((status, index) => ({
      _id: `finding-${index}` as Id<"findings">, _creationTime: index,
      jobId: `review-${index}` as Id<"reviewJobs">, projectId: command.projectId, mrIid: 1,
      provider: "fred", status, disposition: "open", reference: `review-${index}/0`,
      severity: "should_fix", file: "file.ts", title: "Concern", body: "Evidence",
    } satisfies PreviousFinding));
    const lookedUp: string[] = [];
    await test.run(command, {
      control: { context: () => Effect.succeed(previous) },
      gitlab: { findSummary: (marker) => Effect.sync(() => { lookedUp.push(marker); return undefined; }) },
    });
    expect(lookedUp).toEqual(["review-0:summary", "review-1:summary"]);
  });
});
