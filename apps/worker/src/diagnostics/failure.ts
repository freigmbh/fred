import { diagnosticFailure, failureDetailLimit, redactSecrets, type DiagnosticFailure } from "@fred/contracts";
import { accepted } from "./metadata";

type Category = DiagnosticFailure["category"];
type Code = NonNullable<DiagnosticFailure["code"]>;

const taggedCategories = {
  ControllerError: "controller", GitLabError: "gitlab", CloneError: "checkout", ParseError: "output",
  SandboxError: "sandbox", ConfigError: "configuration", Timeout: "timeout", LabelMissing: "gitlab", ProviderError: "provider",
} as const;

const messageRules: { status?: number[]; text?: RegExp; category: Category; code?: Code }[] = [
  { status: [401], text: /authentication_error|invalid.?api.?key|invalid x-api-key|api key.*(?:invalid|missing|not set)/i, category: "authentication", code: "invalid_api_key" },
  { status: [402], text: /insufficient_quota|credit balance|quota.*(?:exceed|exhaust)|billing.*(?:limit|error)/i, category: "quota", code: "insufficient_quota" },
  { status: [429], text: /rate.?limit|rateLimitExceeded/i, category: "rate_limit" },
  { text: /invalid.*schema|schema.*(?:invalid|unsupported)|structured.*output.*schema/i, category: "invalid_request", code: "invalid_schema" },
  { text: /model.*(?:not found|does not exist|not available|invalid)/i, category: "invalid_request", code: "invalid_model" },
  { text: /(?:unknown|unrecognized|unexpected|unsupported) (?:option|argument)/i, category: "configuration", code: "unknown_option" },
  { status: [400, 413, 422], category: "invalid_request" },
  { text: /fetch failed|network|socket|TLS|certificate|transport failed/i, category: "transport" },
];

const codeCategories: Partial<Record<Code, Category>> = {
  ECONNREFUSED: "transport", ECONNRESET: "transport", ENOTFOUND: "transport", ETIMEDOUT: "transport", EPIPE: "transport",
  CERT_HAS_EXPIRED: "transport", UNABLE_TO_VERIFY_LEAF_SIGNATURE: "transport",
};

const boundaryCategories = new Set<Category>(["controller", "gitlab", "checkout", "output", "sandbox", "timeout"]);

// Walks a failure and what it wraps: an object `error` envelope first, else `cause`. Stops after eight links, at a cycle,
// or after yielding a primitive.
export function* causeChain(cause: unknown) {
  const seen = new Set<unknown>();
  for (let current = cause; current !== undefined && current !== null && seen.size < 8 && !seen.has(current);) {
    seen.add(current);
    yield current;
    if (typeof current !== "object") return;
    const envelope = "error" in current && typeof current.error === "object" ? current.error : undefined;
    current = envelope ?? ("cause" in current ? current.cause : undefined);
  }
}

function inspectFailure(cause: unknown, httpStatus?: number): DiagnosticFailure {
  const details: Omit<DiagnosticFailure, "category"> = httpStatus === undefined ? {} : { httpStatus };
  const tags: Category[] = [];
  let text = "";
  for (const current of causeChain(cause)) {
    if (typeof current === "string") { text += current.slice(0, 8192); break; }
    if (typeof current !== "object") break;
    if ("diagnostic" in current) {
      const diagnostic = accepted(diagnosticFailure, current.diagnostic);
      if (diagnostic) return diagnostic;
    }
    if ("_tag" in current && typeof current._tag === "string" && Object.hasOwn(taggedCategories, current._tag)) {
      tags.push(taggedCategories[current._tag as keyof typeof taggedCategories]);
    }
    if ("message" in current && typeof current.message === "string") text += ` ${current.message.slice(0, 8192)}`;
    if ("code" in current) {
      const code = accepted(diagnosticFailure.shape.code, current.code);
      if (code !== undefined) details.code = code;
    }
    if ("status" in current || "statusCode" in current) {
      const status = accepted(diagnosticFailure.shape.httpStatus, "status" in current ? current.status : current.statusCode);
      if (status !== undefined) details.httpStatus = status;
    }
  }
  const status = details.httpStatus;
  const rule = messageRules.find((candidate) => (status !== undefined && candidate.status?.includes(status)) || candidate.text?.test(text));
  let category = rule?.category ?? tags.at(-1) ?? "unexpected";
  if (rule?.code) details.code = rule.code;
  const byCode = details.code && codeCategories[details.code];
  if (byCode) category = byCode;
  const signal = accepted(diagnosticFailure.shape.signal, /\bSIG(?:TERM|KILL|ABRT|SEGV|INT|PIPE|BUS|ILL)\b/.exec(text)?.[0]);
  if (signal !== undefined) details.signal = signal;
  const boundary = tags[0];
  if (boundary !== undefined && boundaryCategories.has(boundary)) category = boundary;
  return { category, ...details };
}

const excerptLimit = 500;
const upstreamFields = ["body", "stderr", "output"] as const;

function describeChain(cause: unknown, secrets: readonly string[]) {
  const excerpt = (text: string) => redactSecrets(text, secrets).slice(0, excerptLimit);
  const lines: string[] = [];
  for (const current of causeChain(cause)) {
    if (typeof current !== "object") { lines.push(String(current)); break; }
    const label = "_tag" in current && typeof current._tag === "string" ? current._tag : current instanceof Error ? current.name : undefined;
    const message = "message" in current && typeof current.message === "string" ? current.message : undefined;
    const status = "status" in current && typeof current.status === "number" ? current.status
      : "statusCode" in current && typeof current.statusCode === "number" ? current.statusCode : undefined;
    const upstream = upstreamFields.flatMap((field) => {
      const value = field in current ? Reflect.get(current, field) : undefined;
      return typeof value === "string" && value.trim() ? [`${field} ${excerpt(value.trim())}`] : [];
    });
    const metadata = "metadata" in current && typeof current.metadata === "object" && current.metadata !== null ? `metadata ${excerpt(JSON.stringify(current.metadata))}` : undefined;
    const line = [label && message ? `${label}: ${message}` : label ?? message, status === undefined ? undefined : `HTTP ${status}`, ...upstream, metadata]
      .filter((part) => part !== undefined).join("; ");
    if (line) lines.push(line);
  }
  return lines.join("\n  caused by ");
}

export function failureDetail(cause: unknown, secrets: readonly string[]) {
  try {
    const text = redactSecrets(describeChain(cause, secrets), secrets).replace(/[\x00-\x09\x0b-\x1f\x7f]/g, " ").trim();
    return text ? text.slice(0, failureDetailLimit) : undefined;
  } catch { return undefined; }
}

// Classifies a failure for storage and comments. Detail text is redacted with `secrets`; a claim passes claimSecrets.
// `httpStatus` is a response status known outside the cause, such as an HTTP response without an error body.
export function classifyFailure(cause: unknown, secrets: readonly string[], httpStatus?: number): DiagnosticFailure {
  let failure: DiagnosticFailure;
  try { failure = inspectFailure(cause, httpStatus); }
  catch { failure = { category: "unexpected" }; }
  const detail = failure.detail ?? failureDetail(cause, secrets);
  return detail === undefined ? failure : { ...failure, detail };
}
