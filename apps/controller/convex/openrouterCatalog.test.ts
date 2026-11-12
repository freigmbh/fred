import type { Model } from "@openrouter/sdk/models";
import { expect, it } from "vitest";
import { toReviewModel } from "./openrouterCatalog";

const model = {
  id: "vendor/model", name: "Model", canonicalSlug: "vendor/model", created: 0,
  contextLength: 100_000, architecture: { modality: "text->text", inputModalities: ["text"], outputModalities: ["text"] },
  topProvider: { isModerated: false, maxCompletionTokens: 10_000 }, supportedParameters: ["tools", "reasoning"],
  pricing: { prompt: "0", completion: "0" }, defaultParameters: null, perRequestLimits: null,
  supportedVoices: null, links: { details: "/api/v1/models/vendor/model/endpoints" },
} satisfies Model;

it("uses the catalog effort allowlist and never disables mandatory reasoning", () => {
  expect(toReviewModel({ ...model, reasoning: { mandatory: true, supportedEfforts: ["max", "high", "none"], defaultEffort: "high" } }))
    .toMatchObject({ efforts: ["default", "high", "max"], defaultEffort: "high", reasoningMandatory: true });
  expect(toReviewModel({ ...model, reasoning: { mandatory: false, supportedEfforts: ["none", "low"], defaultEffort: "none" } }))
    .toMatchObject({ efforts: ["default", "none", "low"], defaultEffort: "default" });
});

it("distinguishes unrestricted effort from missing effort metadata", () => {
  expect(toReviewModel({ ...model, reasoning: { mandatory: false, supportedEfforts: null } })?.efforts)
    .toEqual(["default", "none", "minimal", "low", "medium", "high", "xhigh", "max"]);
  expect(toReviewModel({ ...model, reasoning: { mandatory: true, supportedEfforts: null } })?.efforts)
    .toEqual(["default", "minimal", "low", "medium", "high", "xhigh", "max"]);
  expect(toReviewModel({ ...model, reasoning: { mandatory: true } })?.efforts).toEqual(["default"]);
  expect(toReviewModel(model)?.efforts).toEqual(["default"]);
});

it("admits compatible new models, variants, and aliases without a code catalog or tool-choice requirement", () => {
  for (const id of ["new-vendor/new-model", "vendor/model:free", "~vendor/model-latest", "openrouter/auto"]) {
    expect(toReviewModel({ ...model, id })).toMatchObject({ id, contextLength: 100_000, maxCompletionTokens: 10_000 });
  }
});

it("excludes models that cannot run text reviews with local tools", () => {
  for (const candidate of [
    { ...model, id: "vendor/model:batch" },
    { ...model, id: "legacy-model" },
    { ...model, supportedParameters: [] },
    { ...model, contextLength: null },
    { ...model, architecture: { ...model.architecture, inputModalities: ["image" as const] } },
    { ...model, architecture: { ...model.architecture, outputModalities: ["image" as const] } },
  ]) expect(toReviewModel(candidate)).toBeNull();
});
