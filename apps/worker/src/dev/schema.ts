import { modelSelection } from "@fred/contracts";
import { Data } from "effect";
import { z } from "zod";

export const scenario = z.enum(["success", "provider-failure", "large-diff"]);
export type Scenario = z.infer<typeof scenario>;

const openRouterKey = z.object({ OPENROUTER_API_TOKEN: z.string().min(1) }).strict();

export const verificationRequest = z.object({
  live: z.literal("openrouter").optional(),
  model: modelSelection.shape.model.optional(),
  effort: modelSelection.shape.effort.optional(),
  scenario: scenario.default("success"),
  keys: openRouterKey.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.live && value.scenario === "provider-failure") ctx.addIssue({ code: "custom", message: "Provider failure uses synthetic OpenRouter responses" });
  if (value.live && !value.keys) ctx.addIssue({ code: "custom", message: "Live verification requires the OpenRouter token" });
  if (!value.live && value.keys) ctx.addIssue({ code: "custom", message: "Synthetic verification does not accept credentials" });
});
export type VerificationRequest = z.infer<typeof verificationRequest>;

export class DevelopmentError extends Data.TaggedError("DevelopmentError")<{ message: string }> {}

// The local development service inside a worktree's worker container; the CLI reaches it through the same address.
export const developmentPort = 8787;
export const developmentEndpoint = `http://127.0.0.1:${developmentPort}`;

// Reads a whole request or response body as UTF-8, failing once it exceeds `limit` bytes.
export const readBounded = async (stream: AsyncIterable<unknown>, limit: number) => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += buffer.length;
    if (bytes > limit) throw new Error("Stream exceeds limit");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
};
