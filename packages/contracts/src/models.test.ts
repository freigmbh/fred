import { expect, it } from "vitest";
import { defaultStageModels, modelEffort, modelSelection, stageModels } from "./models";

it("accepts OpenRouter models independently for each pipeline stage", () => {
  expect(stageModels.parse(defaultStageModels)).toEqual(defaultStageModels);
  const pipeline = { detect: { model: "anthropic/claude-fable-5.1", effort: "max" }, validate: { model: "new-vendor/new-model:free", effort: "default" } };
  expect(stageModels.parse(pipeline)).toEqual(pipeline);
  for (const effort of modelEffort.options) {
    expect(modelSelection.parse({ model: "~openai/gpt-astra-latest", effort })).toEqual({ model: "~openai/gpt-astra-latest", effort });
  }
});

it.each([
  { model: "gpt-6-astra", effort: "high" },
  { model: "claude-fable-5-1", effort: "high" },
  { model: "", effort: "default" },
  { model: "openai/", effort: "high" },
  { model: "openai/model\n", effort: "high" },
  { model: "openai/model", effort: "unsupported" },
])("rejects legacy or malformed selection $model / $effort", (selection) => {
  expect(modelSelection.safeParse(selection).success).toBe(false);
});
