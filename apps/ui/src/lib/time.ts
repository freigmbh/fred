import { useMemo } from "react";

export const dayMs = 24 * 60 * 60 * 1000;

// The start of the last `days` days as a timestamp, or null for all time. It moves only when `days` changes, so query
// arguments built from it stay equal between renders and the subscription is not replaced.
export function useWindowStart(days: number | null) {
  return useMemo(() => (days === null ? null : Date.now() - days * dayMs), [days]);
}
