import { failureSummary, redactSecrets, type DiagnosticFailure } from "@fred/contracts";
import { Cause } from "effect";

const traceLimit = 16_384;

// Writes one JSON line to the worker journal. Journaling never fails the caller.
export function journalLine(record: ({ jobId: string } | { commandId: string }) & Record<string, unknown>) {
  try { process.stdout.write(`${JSON.stringify(record)}\n`); } catch {}
}

export function failureTrace(error: unknown, secrets: readonly string[]) {
  try { return redactSecrets(Cause.pretty(Cause.fail(error)), secrets).slice(0, traceLimit); }
  catch { return undefined; }
}

export function failureLine(failure: DiagnosticFailure) {
  const cause = failure.detail?.split("\n")[0];
  return `${failureSummary(failure)}${cause ? ` [${cause}]` : ""}`;
}
