import { describe, expect, it } from "vitest";
import { diagnosticEvent, diagnosticFailure, diagnosticRequest, diagnosticSnapshot, failureSummary, storedDiagnosticSnapshot } from "./diagnostics";

const request = { bytes: 17_200_000, messageCount: 2, largestMessageCharacters: 17_000_000 };

describe("request diagnostic contract", () => {
  it.each(["bytes", "messageCount", "largestMessageCharacters"] as const)("only accepts safe nonnegative integer %s counts", (field) => {
    expect(diagnosticRequest.parse(request)).toEqual(request);
    for (const value of [-1, 0.5, "123", null, undefined, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(diagnosticRequest.safeParse({ ...request, [field]: value }).success).toBe(false);
    }
  });

  it("rejects prompt and arbitrary provider metadata inside failure sizes", () => {
    const failure = { category: "invalid_request", provider: { source: "openrouter", code: "string_too_long" }, request };
    expect(diagnosticFailure.parse(failure)).toEqual(failure);
    expect(diagnosticFailure.safeParse({ ...failure, request: { ...request, prompt: "PRIVATE_SOURCE" } }).success).toBe(false);
    expect(diagnosticFailure.safeParse({ ...failure, provider: { ...failure.provider, raw: "PRIVATE_SOURCE" } }).success).toBe(false);
    expect(diagnosticEvent.parse({ kind: "tool_started", phase: "detect", at: 1, tool: "read_diff" }).tool).toBe("read_diff");
  });
});

describe("failureSummary", () => {
  it("states FRED's own input guard whole, apart from a provider payload rejection with its details", () => {
    const guard = failureSummary({ category: "invalid_request", code: "review_input_too_large" });
    const provider = failureSummary({ category: "invalid_request", provider: { source: "openrouter", code: "payload_too_large" } });
    expect(guard).not.toContain("(");
    expect(provider).toMatch(/payload size limit \(openrouter, payload_too_large\)$/);
  });
});

describe("stored diagnostics", () => {
  const retired = { phase: "detect", at: 1, droppedEvents: 0, leaseGeneration: 1,
    failure: { category: "provider", provider: { source: "codex_rpc", code: "unknown", rpcCode: -32602 } } };

  it("reads what the retired runtimes recorded, but no new snapshot may carry it", () => {
    expect(storedDiagnosticSnapshot.parse(retired)).toEqual(retired);
    expect(diagnosticSnapshot.safeParse(retired).success).toBe(false);
    expect(storedDiagnosticSnapshot.safeParse({ ...retired, prompt: "PRIVATE_SOURCE" }).success).toBe(false);
    expect(failureSummary(storedDiagnosticSnapshot.parse(retired).failure!)).toMatch(/\(codex_rpc, RPC -32602\)$/);
  });
});
