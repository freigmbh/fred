import { redactSecrets } from "@fred/contracts";
import type { FunctionArgs } from "convex/server";
import { Effect } from "effect";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import type { api } from "../../controller/convex/_generated/api";
import type { ClaimedJob } from "./controller";
import { TranscriptError } from "./errors";
import type { StageTranscript } from "./provider";

type StoreArgs = FunctionArgs<typeof api.transcripts.store>;
type Attempt = Pick<StoreArgs, "stage" | "model" | "effort" | "outcome"> & { release?: string | undefined; fredVersion?: string | undefined; reviewRulesSha: string };

// Gzipped transcripts above this size are recorded as omitted. Convex caps one function argument at 16 MiB.
const transcriptByteLimit = 8 * 1024 * 1024;
const gzipAsync = promisify(gzip);

// SHA-256 hex of the review rules a prompt used, so transcripts group by prompt version.
export const rulesSha = (rules: string) => createHash("sha256").update(rules).digest("hex");

// The transcript file's JSON. Every string value is redacted on its own, so an escape in the serialized text is never cut.
function transcriptJson(job: ClaimedJob, attempt: Attempt, live: StageTranscript, endedAt: number, secrets: readonly string[]) {
  const { stage, model, effort, outcome, release, fredVersion, reviewRulesSha } = attempt;
  return JSON.stringify({
    format: "fred-transcript/1", jobId: job._id, provider: job.provider, stage, leaseGeneration: job.leaseGeneration ?? 0,
    model, effort, outcome, release, fredVersion, reviewRulesSha, startedAt: live.startedAt, endedAt, tools: live.tools, messages: live.messages, turns: live.turns,
  }, (_key, value: unknown) => typeof value === "string" ? redactSecrets(value, secrets) : value);
}

// Tool calls of one transcript message, from the SDK's camelCase shape or the raw OpenRouter message kept after an SDK rejection.
function toolCallsOf(message: StageTranscript["messages"][number]) {
  if (message.role !== "assistant") return 0;
  if ("tool_calls" in message && Array.isArray(message.tool_calls)) return message.tool_calls.length;
  return Array.isArray(message.toolCalls) ? message.toolCalls.length : 0;
}

// The transcripts.store arguments for one finished stage attempt: the gzipped file, or an omission above the size limit.
export const transcriptRecord = (job: ClaimedJob, attempt: Attempt, live: StageTranscript, secrets: readonly string[]) => Effect.gen(function* () {
  const endedAt = Date.now();
  const file = yield* Effect.tryPromise({ try: async () => gzipAsync(transcriptJson(job, attempt, live, endedAt, secrets)), catch: (cause) => new TranscriptError({ message: "Cannot build the transcript file", cause }) });
  const { release, fredVersion, ...metadata } = attempt;
  return {
    ...metadata, ...(release ? { release } : {}), ...(fredVersion ? { fredVersion } : {}),
    turns: live.turns.length,
    toolCalls: live.messages.reduce((count, message) => count + toolCallsOf(message), 0),
    durationMs: endedAt - live.startedAt,
    ...(file.byteLength > transcriptByteLimit ? { omitted: "too_large" as const } : { file: new Uint8Array(file).buffer }),
  };
});
