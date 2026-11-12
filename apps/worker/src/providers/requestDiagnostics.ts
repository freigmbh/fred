import type { DiagnosticFailure, DiagnosticRequest } from "@fred/contracts";
import { ApiErrorType } from "@openrouter/sdk/models";
import { z } from "zod";
import { causeChain, classifyFailure } from "../diagnostics/failure";
import { ProviderError } from "../errors";

const wireRequest = z.object({ messages: z.array(z.unknown()) });
const errorEnvelope = z.object({ metadata: z.unknown().optional(), error: z.unknown().optional(), cause: z.unknown().optional() });
const errorMetadata = z.object({
  error_type: z.unknown().optional(), errorType: z.unknown().optional(),
  provider_code: z.unknown().optional(), providerCode: z.unknown().optional(),
});
const payloadTooLarge = { category: "invalid_request", provider: { source: "openrouter", code: "payload_too_large" } } satisfies DiagnosticFailure;
// Failures recognized from OpenRouter's typed error metadata, keyed by its error type or provider code identifiers.
const metadataFailures = new Map<string, DiagnosticFailure>([
  [ApiErrorType.StringTooLong, { category: "invalid_request", provider: { source: "openrouter", code: "string_too_long" } }],
  [ApiErrorType.ContextLengthExceeded, { category: "invalid_request", provider: { source: "openrouter", code: "context_length_exceeded" } }],
  [ApiErrorType.PayloadTooLarge, payloadTooLarge],
  [ApiErrorType.Authentication, { category: "authentication", provider: { source: "openrouter", code: "unauthorized" } }],
  [ApiErrorType.PaymentRequired, { category: "quota", code: "insufficient_quota" }],
  [ApiErrorType.RateLimitExceeded, { category: "rate_limit", provider: { source: "openrouter", code: "rateLimitExceeded" } }],
  [ApiErrorType.ProviderOverloaded, { category: "provider", provider: { source: "openrouter", code: "serverOverloaded" } }],
  [ApiErrorType.ProviderUnavailable, { category: "provider", provider: { source: "openrouter", code: "serverOverloaded" } }],
  [ApiErrorType.InvalidRequest, { category: "invalid_request", provider: { source: "openrouter", code: "badRequest" } }],
  [ApiErrorType.Server, { category: "provider", provider: { source: "openrouter", code: "internalServerError" } }],
  [ApiErrorType.Timeout, { category: "timeout" }],
  ["invalid_api_key", { category: "authentication", code: "invalid_api_key" }],
  ["insufficient_quota", { category: "quota", code: "insufficient_quota" }],
  ["invalid_schema", { category: "invalid_request", code: "invalid_schema" }],
  ["invalid_model", { category: "invalid_request", code: "invalid_model" }],
]);

// Measures the outgoing SDK request from a clone, so the body stays readable for transport. Returns undefined for anything but a chat request.
export async function measureRequest(request: Request): Promise<DiagnosticRequest | undefined> {
  try {
    const body = await request.clone().arrayBuffer();
    const parsed = wireRequest.safeParse(JSON.parse(new TextDecoder().decode(body)));
    if (!parsed.success) return undefined;
    return {
      bytes: body.byteLength,
      messageCount: parsed.data.messages.length,
      largestMessageCharacters: parsed.data.messages.reduce<number>((largest, message) => Math.max(largest, JSON.stringify(message).length), 0),
    };
  } catch { return undefined; }
}

// The failure named by the first recognized OpenRouter metadata identifier in the error envelopes of `cause`.
function structuredFailure(cause: unknown): DiagnosticFailure | undefined {
  try {
    for (const current of causeChain(cause)) {
      const envelope = errorEnvelope.safeParse(current);
      if (!envelope.success) return undefined;
      const metadata = errorMetadata.safeParse(envelope.data.metadata);
      if (!metadata.success) continue;
      for (const code of [metadata.data.error_type, metadata.data.errorType, metadata.data.provider_code, metadata.data.providerCode]) {
        const failure = typeof code === "string" ? metadataFailures.get(code) : undefined;
        if (failure) return failure;
      }
    }
  } catch { return undefined; }
  return undefined;
}

// HTTP statuses that signal a brief upstream condition, not a problem with the request.
const transientStatuses = new Set([408, 429, 500, 502, 503, 504]);

// Upstream overloads, rate limits, and server errors usually clear within seconds, so these requests are worth sending again.
const transient = (failure: DiagnosticFailure) => failure.category === "rate_limit" || failure.provider?.code === "serverOverloaded"
  || (failure.httpStatus !== undefined && transientStatuses.has(failure.httpStatus));

// Classifies one failed OpenRouter request, redacting `secrets` from its detail. `status` is the HTTP status of a
// response whose body named no error; `retryable` marks the requests the model loop sends again.
export function requestFailure(secrets: readonly string[], cause: unknown, status?: number, request?: DiagnosticRequest) {
  const classified = classifyFailure(cause, secrets, status);
  const details = structuredFailure(cause) ?? (classified.httpStatus === 413 ? payloadTooLarge : classified);
  const diagnostic = {
    ...details,
    category: details.category === "unexpected" ? "provider" : details.category,
    ...(classified.httpStatus === undefined ? {} : { httpStatus: classified.httpStatus }),
    ...(request === undefined ? {} : { request }),
    ...(classified.detail === undefined ? {} : { detail: classified.detail }),
  } satisfies DiagnosticFailure;
  return new ProviderError({ message: "OpenRouter review request failed", cause, diagnostic, retryable: transient(diagnostic) });
}
