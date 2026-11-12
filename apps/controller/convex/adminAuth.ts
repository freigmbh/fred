import { ConvexError, v } from "convex/values";
import { matchesSecret } from "./sharedSecret";

export const adminAuth = { adminSecret: v.string() };

// Authenticates every admin function against ADMIN_SECRET. Never authenticates a worker.
export function requireAdmin(secret: string) {
  if (!matchesSecret(secret, process.env.ADMIN_SECRET)) throw new ConvexError("unauthorized");
}
