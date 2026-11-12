import { useQuery, type OptionalRestArgsOrSkip } from "convex/react";
import type { FunctionArgs, FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { useState } from "react";
import { rejectSecret, useAdminSecret } from "./secret";

type AdminQuery = FunctionReference<"query", "public", { adminSecret: string }>;

// Sentences for the bare error codes admin functions throw. Coded errors that carry their own `message` need no entry.
const knownErrors: Record<string, string> = {
  pipeline_changed: "Changed elsewhere. Reset to reload.",
  unsupported_model_selection: "Model or effort not in the catalog.",
  model_catalog_unavailable: "Refresh the catalog first.",
  model_catalog_refresh_failed: "Catalog refresh failed.",
  model_catalog_empty: "OpenRouter listed no models.",
  project_not_found: "The project no longer exists.",
  transcript_unavailable: "No longer stored.",
};

// Subscribes to an admin query with the stored secret added to `args`. Skips while there is no secret or `args` is "skip".
export function useAdminQuery<Query extends AdminQuery>(query: Query, args: Omit<FunctionArgs<Query>, "adminSecret"> | "skip") {
  const { secret } = useAdminSecret();
  const withSecret = secret && args !== "skip" ? { ...args, adminSecret: secret } : "skip";
  // TypeScript cannot resolve useQuery's conditional rest parameter for a generic query; admin queries always take arguments.
  return useQuery(query, ...([withSecret] as OptionalRestArgsOrSkip<Query>));
}

// Whether `cause` is a ConvexError thrown with the bare code `code`, such as "unauthorized".
export function isErrorCode(cause: unknown, code: string) {
  return cause instanceof ConvexError && cause.data === code;
}

// Logs out when `cause` is the controller rejecting the admin secret. Returns whether it did, so the caller skips its own error.
export function signOutIfRejected(cause: unknown) {
  if (!isErrorCode(cause, "unauthorized")) return false;
  rejectSecret();
  return true;
}

// The one line an admin call's failure shows: the controller's own message, the sentence for a known code, else `fallback`,
// which defaults to the error's first line without Convex's bracketed prefixes.
export function errorText(cause: unknown, fallback = firstLine(cause)) {
  if (!(cause instanceof ConvexError)) return fallback;
  const data: unknown = cause.data;
  if (typeof data === "object" && data !== null && "message" in data && typeof data.message === "string") return data.message;
  return (typeof data === "string" ? knownErrors[data] : undefined) ?? fallback;
}

function firstLine(cause: unknown) {
  if (cause instanceof ConvexError && typeof cause.data === "string") return cause.data;
  if (cause instanceof Error) return cause.message.split("\n")[0]?.replace(/^(\[[^\]]*\]\s*)+/, "") || "unknown error";
  return "unknown error";
}

// Runs one admin mutation or action at a time. `run` resolves to whether it succeeded and keeps the message `work` returns;
// return "" to show nothing. A failure keeps errorText with `fallback`, except a rejected secret, which logs out.
export function useAdminCall() {
  const { secret } = useAdminSecret();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  async function run(work: (adminSecret: string) => Promise<string>, fallback: string) {
    if (busy || !secret) return false;
    setBusy(true);
    setError(null);
    setMessage("");
    try {
      setMessage(await work(secret));
      return true;
    } catch (cause) {
      if (!signOutIfRejected(cause)) setError(errorText(cause, fallback));
      return false;
    } finally { setBusy(false); }
  }
  const reset = () => { setError(null); setMessage(""); };
  return { busy, error, message, run, reset };
}

export type AdminCall = ReturnType<typeof useAdminCall>;
