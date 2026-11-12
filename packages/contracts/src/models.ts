import { z } from "zod";

export const stage = z.enum(["detect", "validate"]);

export const reasoningEffort = z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
export const modelEffort = z.enum(["default", ...reasoningEffort.options]);

export const modelSelection = z.object({
  model: z.string().regex(/^~?[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/, "Use an OpenRouter model ID"),
  effort: modelEffort,
}).strict();

// A project's review pipeline: the model and effort for each stage. Copied onto each job at enqueue.
export const stageModels = z.object({ detect: modelSelection, validate: modelSelection }).strict();

// Prefills the pipeline of a newly connected project.
export const defaultStageModels = {
  detect: { model: "openai/gpt-6-astra", effort: "medium" },
  validate: { model: "openai/gpt-6-astra", effort: "medium" },
} as const;
