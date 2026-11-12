import { modelEffort, modelSelection } from "@fred/contracts";
import type { ChatMessages } from "@openrouter/sdk/models";
import { Context, type Effect, type Scope } from "effect";
import { z } from "zod";
import type { WorkerError } from "./errors";
import type { DiffCatalog } from "./diffCatalog";
import type { Workspace } from "./sandbox/workspace";

// Cumulative observations within one fresh provider session, never a promise of exact billed usage.
export const usageSnapshot = z.object({
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheCreationInputTokens: z.number().int().nonnegative().default(0),
  costUsd: z.number().nonnegative().optional(),
  model: modelSelection.shape.model.max(200).optional(),
  final: z.boolean(),
});
export type UsageSnapshot = z.infer<typeof usageSnapshot>;

// Facts of one HTTP response within a stage. `generationId` is OpenRouter's response id, `provider` the routed upstream provider.
export type TranscriptTurn = {
  at: number; latencyMs: number; httpStatus: number;
  generationId?: string; model?: string; provider?: string; finishReason?: string; usage?: unknown;
};

// An assistant message as OpenRouter sent it. The transcript keeps it when the SDK rejects the response or the message itself,
// so every field other than the role stays unvalidated, malformed `tool_calls` included.
export const rawAssistantMessage = z.looseObject({ role: z.literal("assistant") });

// One stage's model conversation as it happens. The provider hands it over once, before the first model request, and keeps
// appending to the same arrays until the stage exits, so the holder reads every turn after success, failure, timeout, or
// interruption without a finalizer inside the provider. `messages` holds every response as it arrives, including ones the
// stage then rejects and the final submission, in the SDK's shape or raw when the SDK rejected the envelope.
export type StageTranscript = { startedAt: number; tools: readonly unknown[]; messages: readonly (ChatMessages | z.infer<typeof rawAssistantMessage>)[]; turns: readonly TranscriptTurn[] };

// One stage run. `schema` validates the submission; `toolSchema` describes it to the model. `secrets` are redacted from failures.
export type StageInput<A> = {
  stage: "detect" | "validate";
  workspace: Workspace;
  diffCatalog: DiffCatalog;
  prompt: string;
  model: string;
  effort: z.infer<typeof modelEffort>;
  schema: z.ZodType<A>;
  toolSchema: z.ZodType;
  secrets: readonly string[];
  onUsage: (snapshot: UsageSnapshot) => Effect.Effect<void, WorkerError>;
  onTranscript?: (live: StageTranscript) => void;
};

export class ReviewProvider extends Context.Service<ReviewProvider, {
  run: <A>(input: StageInput<A>) => Effect.Effect<{ output: A; usageConfirmed: boolean; hints: string[] }, WorkerError, Scope.Scope>;
}>()("fred/ReviewProvider") {}
