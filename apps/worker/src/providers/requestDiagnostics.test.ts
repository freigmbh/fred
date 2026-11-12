import { OpenRouter } from "@openrouter/sdk";
import { HTTPClient } from "@openrouter/sdk/lib/http";
import { diagnosticFailure, failureSummary, type DiagnosticRequest } from "@fred/contracts";
import { describe, expect, it } from "vitest";
import { measureRequest, requestFailure } from "./requestDiagnostics";

const requestSize = { bytes: 17_200_000, messageCount: 2, largestMessageCharacters: 17_000_000 };
const classified = (failure: ReturnType<typeof requestFailure>) => {
  const { detail: _detail, ...fields } = diagnosticFailure.parse(failure.diagnostic);
  return fields;
};

describe("OpenRouter request diagnostics", () => {
  it.each(["string_too_long", "context_length_exceeded", "payload_too_large"] as const)("preserves %s from raw and SDK metadata and keeps the redacted upstream text as detail only", (code) => {
    for (const metadata of [{ error_type: code }, { errorType: code }, { provider_code: code }, { providerCode: code }]) {
      for (const status of [200, 400]) {
        const error = { message: "Upstream says sk-or-v1-0123456789abcdef0123 is too long", metadata: { ...metadata, raw: "UPSTREAM_RAW" } };
        for (const cause of [error, { statusCode: status, error }, { cause: error }]) {
          const failure = requestFailure([], cause, status, requestSize);
          expect(classified(failure)).toEqual({ category: "invalid_request", provider: { source: "openrouter", code }, httpStatus: status, request: requestSize });
          const summary = failureSummary(diagnosticFailure.parse(failure.diagnostic));
          expect(summary).toContain(code);
          expect(summary).not.toMatch(/Upstream|UPSTREAM_RAW/);
          expect(failure.diagnostic?.detail).toMatch(/Upstream says \[redacted\] is too long/);
          expect(JSON.stringify(failure.diagnostic)).not.toContain("sk-or-v1");
        }
      }
    }
  });

  it.each([
    ["authentication", "authentication", "unauthorized"],
    ["rate_limit_exceeded", "rate_limit", "rateLimitExceeded"],
    ["provider_overloaded", "provider", "serverOverloaded"],
    ["provider_unavailable", "provider", "serverOverloaded"],
    ["invalid_request", "invalid_request", "badRequest"],
    ["server", "provider", "internalServerError"],
  ])("maps the exact %s type to the existing %s category", (errorType, category, code) => {
    expect(classified(requestFailure([], { metadata: { error_type: errorType } }, 400))).toEqual({ category, provider: { source: "openrouter", code }, httpStatus: 400 });
  });

  it("maps known quota and timeout identifiers without matching arbitrary text", () => {
    expect(classified(requestFailure([], { metadata: { error_type: "payment_required" } }, 200))).toEqual({ category: "quota", code: "insufficient_quota", httpStatus: 200 });
    expect(classified(requestFailure([], { metadata: { error_type: "timeout" } }, 200))).toEqual({ category: "timeout", httpStatus: 200 });
    expect(classified(requestFailure([], { metadata: { error_type: "unmapped", provider_code: "invalid_schema" } }, 400))).toEqual({ category: "invalid_request", code: "invalid_schema", httpStatus: 400 });
  });

  it("retains status classification when metadata is unknown, malformed, cyclic, or unreadable", () => {
    const cyclic: { cause?: unknown } = {};
    cyclic.cause = cyclic;
    for (const cause of [
      { metadata: { error_type: "PRIVATE_SOURCE", provider_code: "string_too_long PRIVATE_SOURCE" } },
      { metadata: { error_type: { token: "PRIVATE_SOURCE" }, provider_code: ["context_length_exceeded"] } },
      { get metadata() { throw new Error("PRIVATE_SOURCE"); } },
      cyclic,
    ]) {
      expect(classified(requestFailure([], cause, 400, requestSize))).toEqual({ category: "invalid_request", httpStatus: 400, request: requestSize });
    }
    expect(classified(requestFailure([], { statusCode: 413 }))).toEqual({ category: "invalid_request", provider: { source: "openrouter", code: "payload_too_large" }, httpStatus: 413 });
    expect(classified(requestFailure([], undefined, 429))).toEqual({ category: "rate_limit", httpStatus: 429 });
  });

  it("measures actual SDK wire bytes and serialized messages before transport without consuming its body", async () => {
    let measured: DiagnosticRequest | undefined;
    let wireBody = "";
    let wireBytes = 0;
    const transport = new HTTPClient({ fetcher: async (source, init) => {
      const request = new Request(source, init);
      const bytes = await request.arrayBuffer();
      wireBytes = bytes.byteLength;
      wireBody = new TextDecoder().decode(bytes);
      return Response.json({ error: { code: 400, message: "PRIVATE_SOURCE", metadata: { error_type: "context_length_exceeded" } } }, { status: 400 });
    } }).addHook("beforeRequest", async (request) => { measured = await measureRequest(request); });
    const client = new OpenRouter({ apiKey: "sk-private", httpClient: transport, retryConfig: { strategy: "none" } });
    const messages = [
      { role: "user" as const, content: 'Unicode ä🐝, a newline\nand "quotes"' },
      { role: "tool" as const, toolCallId: "read-file", content: "PRIVATE_SOURCE".repeat(15) },
    ];
    const failure = await client.chat.send({ chatRequest: { model: "fixture/model", sessionId: "fixture-session", messages, stream: false } }).catch((cause: unknown) => requestFailure([], cause, undefined, measured));
    const wire: { messages: unknown[]; session_id: string } = JSON.parse(wireBody);
    expect(wire.session_id).toBe("fixture-session");
    expect(wire.messages[1]).toMatchObject({ tool_call_id: "read-file" });
    expect(measured).toEqual({ bytes: wireBytes, messageCount: 2, largestMessageCharacters: Math.max(...wire.messages.map((message) => JSON.stringify(message).length)) });
    expect(wireBytes).toBeGreaterThan(wireBody.length);
    expect(failure).toMatchObject({ diagnostic: { provider: { code: "context_length_exceeded" }, request: measured } });
    expect(JSON.stringify(failure)).not.toContain("sk-private");
  });

  it("cannot disrupt transport when the body cannot be measured", async () => {
    for (const body of ["not JSON", "{}", '{"messages":"PRIVATE_SOURCE"}']) {
      const request = new Request("https://example.invalid", { method: "POST", body });
      expect(await measureRequest(request)).toBeUndefined();
      expect(await request.text()).toBe(body);
    }
  });
});
