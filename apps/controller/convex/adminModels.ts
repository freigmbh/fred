import { stageModels as pipelineSchema } from "@fred/contracts";
import { ConvexError, v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";
import { catalogModel } from "./schema";

// Returns `value` as a pipeline when every stage names a catalog model with a supported effort.
// Throws `unsupported_model_selection` or `model_catalog_unavailable` otherwise.
export function validatePipeline(value: unknown, catalog: Doc<"modelCatalog"> | null) {
  const pipeline = pipelineSchema.safeParse(value);
  if (!pipeline.success) throw new ConvexError("unsupported_model_selection");
  if (!catalog) throw new ConvexError("model_catalog_unavailable");
  for (const selection of Object.values(pipeline.data)) {
    const model = catalog.models.find((entry) => entry.id === selection.model);
    if (!model?.efforts.includes(selection.effort)) throw new ConvexError("unsupported_model_selection");
  }
  return pipeline.data;
}

// Saves a complete catalog only after discovery succeeds. Concurrent refreshes cannot replace a newer snapshot.
export const replaceCatalog = internalMutation({
  args: { models: v.array(catalogModel), fetchedAt: v.number() },
  handler: async (ctx, args) => {
    if (args.models.length === 0) throw new ConvexError("model_catalog_empty");
    const current = await ctx.db.query("modelCatalog").unique();
    if (current && current.fetchedAt > args.fetchedAt) return;
    if (current) await ctx.db.replace(current._id, args);
    else await ctx.db.insert("modelCatalog", args);
  },
});
