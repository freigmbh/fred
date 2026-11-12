import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference, type FunctionReturnType } from "convex/server";
import { Effect } from "effect";
import type { Doc, Id } from "../../../controller/convex/_generated/dataModel";
import { DevelopmentError, type VerificationRequest } from "./schema";

const state = makeFunctionReference<"query", Record<string, never>, {
  jobs: Doc<"reviewJobs">[]; findings: Doc<"findings">[]; usage: Doc<"usageEvents">[];
  notes: Doc<"mrNotes">[]; diagnostics: Doc<"diagnosticEvents">[]; snapshots: Doc<"diagnosticSnapshots">[];
}>("dev:state");
type ModelOverrides = Pick<VerificationRequest, "model" | "effort">;
const enqueue = makeFunctionReference<"mutation", { runId: string } & ModelOverrides, Id<"reviewJobs">>("dev:enqueue");

export type DevelopmentState = FunctionReturnType<typeof state>;

// Opens an admin client for the internal development functions. The published client types omit
// admin authentication, so it is looked up at runtime and the runtime refuses to start without it.
export const connectBackend = (url: string, adminKey: string) => Effect.try({
  try: () => {
    const client = new ConvexHttpClient(url);
    const authenticate: unknown = Reflect.get(client, "setAdminAuth");
    if (typeof authenticate !== "function") throw new Error("Admin authentication unavailable");
    authenticate.call(client, adminKey);
    return {
      inspect: Effect.tryPromise({ try: () => client.query(state, {}), catch: () => new DevelopmentError({ message: "Cannot inspect local backend" }) }),
      enqueue: (runId: string, overrides: ModelOverrides) => Effect.tryPromise({
        try: () => client.mutation(enqueue, { runId, ...overrides }), catch: () => new DevelopmentError({ message: "Cannot enqueue local fixture" }),
      }),
    };
  },
  catch: () => new DevelopmentError({ message: "Cannot connect local backend admin client" }),
});

export type DevelopmentBackend = Effect.Success<ReturnType<typeof connectBackend>>;
