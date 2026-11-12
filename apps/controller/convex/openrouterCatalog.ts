import { modelEffort, modelSelection, reasoningEffort } from "@fred/contracts";
import { OpenRouter } from "@openrouter/sdk";
import type { Model } from "@openrouter/sdk/models";
import { OpenRouterError } from "@openrouter/sdk/models/errors";
import { ConvexError } from "convex/values";
import { internal } from "./_generated/api";
import { action } from "./_generated/server";
import { adminAuth, requireAdmin } from "./adminAuth";

// The review catalog entry for SDK model metadata, or null for a model that cannot run text reviews with local tools.
export function toReviewModel(model: Model) {
  if (!modelSelection.shape.model.safeParse(model.id).success || model.id.endsWith(":batch")
    || !model.supportedParameters.includes("tools")
    || !model.architecture.inputModalities.includes("text") || !model.architecture.outputModalities.includes("text")
    || !model.contextLength || model.contextLength < 0) return null;

  const reasoning = model.reasoning;
  const supported = reasoning?.supportedEfforts === null ? reasoningEffort.options : reasoning?.supportedEfforts ?? [];
  const efforts = modelEffort.options.filter((effort) => effort === "default"
    || (supported.includes(effort) && !(reasoning?.mandatory && effort === "none")));
  const defaultEffort = efforts.find((effort) => effort !== "none" && effort === reasoning?.defaultEffort) ?? "default";
  return {
    id: model.id, label: model.name, contextLength: model.contextLength,
    maxCompletionTokens: model.topProvider.maxCompletionTokens ?? null,
    supportedParameters: [...model.supportedParameters], efforts, defaultEffort,
    reasoningMandatory: reasoning?.mandatory ?? false,
  };
}

// Refreshes the public catalog through the SDK without provider credentials. Called by the admin and local setup.
export const refreshModels = action({
  args: adminAuth,
  handler: async (ctx, args) => {
    requireAdmin(args.adminSecret);
    const fetchedAt = Date.now();
    const client = new OpenRouter({
      serverURL: "https://openrouter.ai/api/v1", timeoutMs: 30_000, retryConfig: { strategy: "none" },
      debugLogger: { group() {}, groupEnd() {}, log() {} },
    });
    const models = new Map<string, NonNullable<ReturnType<typeof toReviewModel>>>();
    try {
      for await (const page of await client.models.list()) {
        for (const entry of page.result.data) {
          const model = toReviewModel(entry);
          if (model) models.set(model.id, model);
        }
      }
    } catch (cause) {
      // SDK errors can embed the raw response body, so only the classification is logged.
      console.error("model_catalog_refresh_failed", {
        name: cause instanceof Error ? cause.name : typeof cause,
        ...(cause instanceof OpenRouterError ? { statusCode: cause.statusCode } : {}),
      });
      throw new ConvexError("model_catalog_refresh_failed");
    }
    await ctx.runMutation(internal.adminModels.replaceCatalog, {
      models: [...models.values()].sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id)), fetchedAt,
    });
    return { count: models.size, fetchedAt };
  },
});
