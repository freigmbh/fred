import { HTTPClient } from "@openrouter/sdk/lib/http";
import { Effect, Layer } from "effect";
import { expect, it } from "vitest";
import fixture from "../../../fixtures/reviews/basic.json";
import { chatCompletion, toolCall } from "./fixtures";
import { ReviewProvider } from "./provider";
import { runOpenRouterStage } from "./providers/openrouter";
import { runJob } from "./runJob";
import { fixtureJob, testServices } from "./testLayers";

it.each([
  { corrected: true, invalid: "missing verdicts" },
  { corrected: false, invalid: "missing verdicts" },
  { corrected: true, invalid: "missing reason" },
  { corrected: false, invalid: "missing reason" },
] as const)("corrects $invalid once, corrected=$corrected", async ({ corrected, invalid }) => {
  const test = testServices();
  const requests: unknown[] = [];
  const provider = Layer.succeed(ReviewProvider, { run: (input) => runOpenRouterStage(input, "synthetic", new HTTPClient({
    fetcher: async (source, init) => {
      if (input.stage === "validate") requests.push(await new Request(source, init).json());
      const output = input.stage === "validate" && (requests.length === 1 || !corrected)
        ? { verdicts: invalid === "missing reason" ? [{ index: 0, verdict: "rejected" }] : [], findingDecisions: [] } : fixture[input.stage];
      return Response.json(chatCompletion({
        id: `fixture-${input.stage}-${requests.length}`, model: input.model, usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cost: 0.001 },
        calls: [toolCall("submit_review", output, `submission-${requests.length}`)],
      }));
    },
  })) });
  await Effect.runPromise(runJob(fixtureJob).pipe(Effect.provide(provider), Effect.provide(test.layers)));
  expect(requests).toHaveLength(2);
  expect(requests[1]).toMatchObject({ messages: expect.arrayContaining([
    expect.objectContaining({ role: "tool", content: expect.stringMatching(invalid === "missing reason" ? /submit_review was rejected[\s\S]*reason/ : /submit_review was rejected[\s\S]*exactly one verdict/) }),
  ]) });
  // One usage row per OpenRouter response: detect, the rejected submission, and its repair.
  expect(test.calls.filter((call) => call === "usage")).toHaveLength(3);
  if (corrected) {
    expect(test.saved()).toBeDefined();
    expect(test.calls).toContain("complete");
    expect(test.calls.indexOf("save")).toBeLessThan(test.calls.indexOf("summary"));
  } else {
    expect(test.saved()).toBeUndefined();
    expect(test.calls).toContain("fail");
    expect(test.calls).not.toContain("summary");
    expect(test.calls).not.toContain("label");
  }
});
