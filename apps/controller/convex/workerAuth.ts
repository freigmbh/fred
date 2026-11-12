import { ConvexError, v } from "convex/values";
import { matchesSecret } from "./sharedSecret";

export const workerAuth = { workerSecret: v.string() };

// Authenticates every worker function against WORKER_SECRET. Never authenticates an admin.
export function requireWorker(secret: string) {
  if (!matchesSecret(secret, process.env.WORKER_SECRET)) throw new ConvexError("unauthorized");
}
