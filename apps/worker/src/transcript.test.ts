import { Effect } from "effect";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { StageTranscript } from "./provider";
import { fixtureJob } from "./testLayers";
import { transcriptRecord } from "./transcript";

describe("transcript file", () => {
  it("redacts a secret inside a tool result and gzips valid JSON", async () => {
    const secret = "synthetic-openrouter-secret";
    const live = {
      startedAt: 1, tools: [],
      messages: [
        { role: "assistant", tool_calls: [{ id: "read-1", type: "function", function: { name: "read", arguments: "{}" } }] },
        { role: "tool", toolCallId: "read-1", content: `const key = "${secret}";\n// quotes " and backslashes \\ survive` },
      ],
      turns: [{ at: 2, latencyMs: 1, httpStatus: 200, generationId: "gen-1" }],
    } satisfies StageTranscript;
    const record = await Effect.runPromise(transcriptRecord(fixtureJob,
      { stage: "detect", model: "m", effort: "high", outcome: "completed", reviewRulesSha: "rules" }, live, [secret]));
    if (!("file" in record)) throw new Error("expected a file below the size limit");
    const text = gunzipSync(Buffer.from(record.file)).toString();
    expect(text).not.toContain(secret);
    expect(JSON.parse(text)).toMatchObject({
      format: "fred-transcript/1", jobId: fixtureJob._id, provider: fixtureJob.provider, stage: "detect", leaseGeneration: 1, reviewRulesSha: "rules",
      messages: [{ role: "assistant" }, { content: 'const key = "[redacted]";\n// quotes " and backslashes \\ survive' }], turns: [{ generationId: "gen-1" }],
    });
    expect(record).toMatchObject({ turns: 1, toolCalls: 1, reviewRulesSha: "rules" });
  });
});
