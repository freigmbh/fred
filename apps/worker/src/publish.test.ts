import { stage1Output, stage2Output } from "@fred/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import fixture from "../../../fixtures/reviews/basic.json";
import { ControllerError, GitLabError } from "./errors";
import { publishResult } from "./publish";
import { buildResult } from "./result";
import { fixtureContext } from "./fixtures";
import { fixtureJob, testServices } from "./testLayers";

const result = () => buildResult({ jobId: "fixture-job", botUserIds: [3], candidates: stage1Output.parse(fixture.detect).candidates, validation: stage2Output.parse(fixture.validate), previous: [], context: fixtureContext, hints: [] });

describe("publication recovery", () => {
  it("acknowledges an unsupported inline anchor only after the full finding is in the summary", async () => {
    const test = testServices();
    const intent = await Effect.runPromise(result());
    const gitlab = { ...test.gitlab, publishDiscussion: () => Effect.fail(new GitLabError({ message: "invalid position", status: 400 })) };
    await Effect.runPromise(publishResult(fixtureJob, intent, test.control, gitlab));
    expect(test.calls).toEqual(["summary", "ack:summary", "ack:finding:0", "label", "ack:label", "complete"]);
  });

  it("stops subsequent effects when a push changes the MR head", async () => {
    const test = testServices();
    const intent = await Effect.runPromise(result());
    let checks = 0;
    const gitlab = { ...test.gitlab, isCurrent: () => Effect.sync(() => ++checks === 1) };
    await Effect.runPromise(publishResult(fixtureJob, intent, test.control, gitlab));
    expect(test.calls).toEqual(["summary", "ack:summary", "supersede"]);
  });

  it("never starts publication while the controller is disconnected", async () => {
    const test = testServices();
    await expect(Effect.runPromise(publishResult(fixtureJob, await Effect.runPromise(result()), { ...test.control, heartbeat: () => Effect.fail(new ControllerError({ message: "disconnected" })) }, test.gitlab))).rejects.toThrow("disconnected");
    expect(test.calls).toEqual([]);
  });
});
