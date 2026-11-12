import { HTTPClient } from "@openrouter/sdk/lib/http";
import { Effect, Layer } from "effect";
import { z } from "zod";
import fixture from "../../../../fixtures/reviews/basic.json";
import { catalogPage, diffPage } from "../diffCatalog";
import { chatCompletion } from "../fixtures";
import { ReviewProvider, type StageInput } from "../provider";
import { runOpenRouterStage } from "../providers/openrouter";
import type { Scenario } from "./schema";
import { largeDiffOutput } from "./largeDiff";

// Stands in for the provider when a run must not call a model, such as recovering stored publication.
export const NoProvider = Layer.succeed(ReviewProvider, { run: () => Effect.die(new Error("This run must not call a model")) });

type ToolCall = { name: string; arguments: string };
type ScriptedStage = Pick<StageInput<unknown>, "stage" | "diffCatalog">;
// A scripted stage yields one tool call per model turn, receives that call's result text, and returns the final submission.
type Script = Generator<ToolCall, ToolCall, string>;
const wireMessages = z.object({ messages: z.array(z.object({ role: z.string(), content: z.unknown().optional() })) });
const lastToolResult = async (request: Request) => {
  const { messages } = wireMessages.parse(await request.json());
  return z.string().optional().parse(messages.findLast((message) => message.role === "tool")?.content);
};
const call = (name: string, args: unknown): ToolCall => ({ name, arguments: JSON.stringify(args) });

function* basicScript({ stage }: ScriptedStage): Script {
  yield call("read", { path: "src/counter.ts" });
  return call("submit_review", fixture[stage]);
}

// Reads the whole paged catalog, then each scoped patch through its continuation cursors, then the checkout, before submitting.
function* largeDiffScript({ stage, diffCatalog }: ScriptedStage): Script {
  let catalogCursor: number | null = 0;
  while (catalogCursor !== null) {
    catalogCursor = catalogPage.parse(JSON.parse(yield call("list_diffs", { cursor: catalogCursor }))).nextCursor;
  }
  for (const path of ["src/counter.ts", "src/assertAvailable.ts"]) {
    const entry = diffCatalog.entries.find((entry) => entry.newPath === path);
    if (!entry) throw new Error("Missing large-diff fixture entry");
    let cursor: z.infer<typeof diffPage>["nextCursor"] = null;
    do {
      cursor = diffPage.parse(JSON.parse(yield call("read_diff", { id: entry.id, range: "scope", ...(cursor ? { cursor } : {}) }))).nextCursor;
    } while (cursor !== null);
  }
  for (const path of ["src/counter.ts", "src/reserve.ts"]) yield call("read", { path });
  return call("submit_review", largeDiffOutput[stage]);
}

// Exercises the real SDK and controlled checkout reads while replacing only OpenRouter HTTP responses.
export const FixtureProvider = (scenario: Scenario) => Layer.succeed(ReviewProvider, {
  run: (input) => {
    let calls = 0;
    let submission: ToolCall | undefined;
    const script = scenario === "large-diff" ? largeDiffScript(input) : basicScript(input);
    // Repeats the submission once the script has returned, so a repair turn after submit_review still gets an answer.
    const nextToolCall = async (request: Request) => {
      if (submission) return submission;
      const result = await lastToolResult(request);
      const step = result === undefined ? script.next() : script.next(result);
      if (step.done) submission = step.value;
      return step.value;
    };
    const transport = new HTTPClient({ fetcher: async (request, init) => {
      if (scenario === "provider-failure") return Response.json({ error: { code: 503, message: "Synthetic OpenRouter failure" } }, { status: 503 });
      const tool = await nextToolCall(new Request(request, init));
      calls++;
      return Response.json(chatCompletion({
        id: `fixture-${input.stage}-${calls}`, model: input.model,
        calls: [{ id: `fixture-tool-${calls}`, type: "function", function: tool }],
      }));
    } });
    return runOpenRouterStage(input, "synthetic", transport).pipe(Effect.map((result) => ({
      ...result, hints: [...result.hints, "OpenRouter HTTP responses are synthetic."],
    })));
  },
});
