import { fileURLToPath } from "node:url";
import { Effect, Layer } from "effect";
import { Git } from "./git";
import type { ReviewContext } from "./reviewInput";

// Synthetic review inputs shared by the worker tests and local verification. Nothing here reaches a real service.

export const fixtureProjectId = "1";
export const localConvexUrl = "http://127.0.0.1:3210";
const headSha = "a".repeat(40);
const baseSha = "b".repeat(40);
const diff = [{ old_path: "src/counter.ts", new_path: "src/counter.ts", diff: "@@ -1,3 +1,3 @@\n export function counter(input: number | undefined) {\n-  return input ?? 1;\n+  return input || 1;\n }", new_file: false, renamed_file: false, deleted_file: false }];

// A full review of fixtures/review-repos/basic: one changed file whose default turns zero into one.
export const fixtureContext: ReviewContext = {
  mrUrl: "http://127.0.0.1/fixtures/example/-/merge_requests/1", title: "Preserve counter inputs", description: "Synthetic merge request", reviewBaseSha: baseSha,
  diffRefs: { base_sha: baseSha, start_sha: baseSha, head_sha: headSha },
  fullDiff: diff, reviewDiff: diff, discussions: [], hints: [], cloneUrl: "http://127.0.0.1/fixtures/example.git",
};

export const FixtureGit = Layer.succeed(Git, { checkout: () => Effect.succeed({
  path: fileURLToPath(new URL("../../../fixtures/review-repos/basic", import.meta.url)),
}) });

// Worker settings for fixture mode with a controller on this machine; `overrides` replaces or adds variables.
export const fixtureEnvironment = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  CONVEX_URL: localConvexUrl, GITLAB_URL: "http://127.0.0.1", WORKER_SECRET: "fixture-secret", OPENROUTER_API_TOKEN: "fixture-key",
  WORKER_FIXTURE_PROJECT_IDS: fixtureProjectId, AI_REVIEW_LIVE: "1", ...overrides,
});

export const toolCall = (name: string, args: unknown, id = name) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });

// The JSON of one OpenRouter chat completion in which the model calls `calls`.
export const chatCompletion = ({ calls, id = "synthetic-completion", model = "synthetic/review-model", finish = "tool_calls", usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cost: 0 } }: {
  calls: ReturnType<typeof toolCall>[]; id?: string; model?: string; finish?: string; usage?: Record<string, number>;
}) => ({
  id, object: "chat.completion", created: 1, model, system_fingerprint: null,
  choices: [{ index: 0, finish_reason: finish, message: { role: "assistant", content: null, tool_calls: calls } }], usage,
});
