import { diagnosticEvent, secretValues } from "@fred/contracts";
import { Context, Effect, Layer } from "effect";
import { z } from "zod";
import { ConfigError } from "./errors";

// True for an HTTP(S) URL without credentials, query string, or fragment, and, when `origin` is given, on that URL's origin.
export const plainHttpUrl = (value: string, origin?: string) => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
    && (origin === undefined || (URL.canParse(origin) && url.origin === new URL(origin).origin));
};

// The SemVer 2.0.0 grammar from semver.org: no leading zeroes in numeric identifiers, no empty identifiers.
const semver = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;
const httpUrl = z.url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol), "Use an HTTP(S) URL");
const settings = z.object({
  CONVEX_URL: httpUrl,
  WORKER_SECRET: z.string().min(1),
  GITLAB_URL: httpUrl,
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(8),
  WORKER_MODE: z.enum(["fixture", "service"]).default("fixture"),
  AI_REVIEW_LIVE: z.string().optional(),
  WORKER_FIXTURE_PROJECT_IDS: z.string().default("").transform((ids) => ids.split(",").map((id) => id.trim()).filter(Boolean)),
  OPENROUTER_API_TOKEN: z.string().min(1),
  FRED_VERSION: z.preprocess((value) => value === "" ? undefined : value, z.string().regex(semver, "Use a SemVer 2.0.0 version").optional()),
  // A malformed release SHA is dropped instead of refusing to start; it only labels diagnostics and transcripts.
  FRED_RELEASE_SHA: z.string().optional().transform((value) => diagnosticEvent.shape.release.safeParse(value).data),
}).superRefine((value, ctx) => {
  const url = new URL(value.CONVEX_URL);
  if (url.hostname.endsWith(".convex.cloud") || url.hostname.endsWith(".convex.site")) {
    ctx.addIssue({ code: "custom", path: ["CONVEX_URL"], message: "FRED uses self-hosted Convex only" });
  }
  for (const key of ["CONVEX_URL", "GITLAB_URL"] as const) {
    if (!plainHttpUrl(value[key])) ctx.addIssue({ code: "custom", path: [key], message: "URLs must not contain credentials, query strings, or fragments" });
  }
  if (value.WORKER_MODE === "fixture") {
    if (value.AI_REVIEW_LIVE !== "1") {
      ctx.addIssue({ code: "custom", path: ["AI_REVIEW_LIVE"], message: "Set AI_REVIEW_LIVE=1 only for an authorized provider check" });
    }
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      ctx.addIssue({ code: "custom", path: ["CONVEX_URL"], message: "Fixture mode requires a controller on this machine" });
    }
    if (value.WORKER_FIXTURE_PROJECT_IDS.length === 0) {
      ctx.addIssue({ code: "custom", path: ["WORKER_FIXTURE_PROJECT_IDS"], message: "Name the fixture GitLab project IDs" });
    }
  }
});

// Parses worker settings before opening a controller connection or starting providers. `secrets` holds every
// secret-named value of `env`, for redaction; a claim adds its project token.
export const readConfig = (env: NodeJS.ProcessEnv) => Effect.try({
  try: () => ({ ...settings.parse(env), secrets: secretValues(env) }),
  catch: (cause) => new ConfigError({ message: cause instanceof z.ZodError ? `Invalid worker configuration: ${cause.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}` : "Invalid worker configuration", cause }),
});

export class WorkerConfig extends Context.Service<WorkerConfig, Effect.Success<ReturnType<typeof readConfig>>>()("fred/WorkerConfig") {}
export const WorkerConfigLive = Layer.effect(WorkerConfig, readConfig(process.env));
