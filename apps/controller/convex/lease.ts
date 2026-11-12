import { ConvexError } from "convex/values";

// How long a claim or heartbeat keeps a review job or finding command owned.
export const LEASE_MS = 2 * 60 * 1000;

// The lease expiry stale cleanup stores on a publishing job once it has reported the lost lease. The job stays claimable and
// leaves the expiry scan.
export const REPORTED_EXPIRY = 0;

type Leased = { _id: string; status: string; leaseToken?: string | undefined; leaseExpiresAt?: number | undefined; leaseGeneration?: number | undefined };

// The lease fields a claim writes: the next generation and a token naming the work, the generation, and the worker.
export function grantLease(work: Leased, workerId: string, now: number) {
  const leaseGeneration = (work.leaseGeneration ?? 0) + 1;
  return { workerId, leaseToken: `${work._id}:${leaseGeneration}:${workerId}`, leaseGeneration, leaseExpiresAt: now + LEASE_MS };
}

// True while running or publishing work has a lease that has not expired.
export function leaseLive(work: Pick<Leased, "status" | "leaseExpiresAt">, now = Date.now()) {
  return (work.status === "running" || work.status === "publishing") && (work.leaseExpiresAt ?? 0) > now;
}

// The rejection for a former or unknown owner. Workers stop on its `lease_lost` code without writing a failure.
export function leaseLost() {
  return new ConvexError({ code: "lease_lost", message: "lease lost" });
}

// Returns `work` when `leaseToken` names its latest lease, live or expired. Throws lease_lost otherwise.
export function lastOwner<W extends Leased>(work: W | null, leaseToken: string) {
  if (!work || work.leaseToken !== leaseToken) throw leaseLost();
  return work;
}

// Returns `work` when `leaseToken` holds a live lease on it. With `finished`, the last owner of work that left running and
// publishing also passes, so it can flush late reports. Throws lease_lost otherwise.
export function requireLease<W extends Leased>(work: W | null, leaseToken: string, { finished = false } = {}) {
  const owned = lastOwner(work, leaseToken);
  const active = owned.status === "running" || owned.status === "publishing";
  if (active ? !leaseLive(owned) : !finished) throw leaseLost();
  return owned;
}

// True when the owner of `leaseToken` already moved `work` to `status`, so it can repeat that terminal call without a live lease.
export function finishedBy(work: Leased | null, leaseToken: string, status: string) {
  return work?.status === status && work.leaseToken === leaseToken;
}
