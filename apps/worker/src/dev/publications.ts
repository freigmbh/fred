import { decisionPublication, provider, publicationEffect, type ReviewVerdict } from "@fred/contracts";
import { randomUUID } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { Effect, Layer } from "effect";
import { z } from "zod";
import { GitLabError } from "../errors";
import { fixtureContext } from "../fixtures";
import { GitLab, type GitLabReview, type MrScope } from "../gitlab";
import type { ReviewContext } from "../reviewInput";

const publication = z.object({
  id: z.string(), runId: z.string(), mrIid: z.number(), provider,
  kind: z.enum(publicationEffect.options.map((effect) => effect.shape.kind.value)), at: z.number(),
  marker: z.string().optional(), body: z.string().optional(), label: decisionPublication.shape.label.optional(),
});
type Publication = z.infer<typeof publication>;

const readCapture = (path: string) => Effect.tryPromise({
  try: async () => {
    const content = await readFile(path, "utf8").catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
      throw error;
    });
    return content.split("\n").filter(Boolean).map((line) => publication.parse(JSON.parse(line)));
  },
  catch: () => new GitLabError({ message: "Cannot read local publication capture" }),
});

export const openPublications = (path: string) => Effect.gen(function* () {
  const rows = yield* readCapture(path);
  // Captures every GitLab write of one run instead of sending it. Rows from earlier runs reconcile like GitLab markers.
  const layer = (runId: string, context: ReviewContext = fixtureContext) => {
    const capture = ({ mrIid }: MrScope) => {
      const find = (kind: Publication["kind"], marker: string) => rows.find((row) => row.mrIid === mrIid && row.kind === kind && row.marker === marker);
      const save = (value: Pick<Publication, "kind" | "marker" | "body" | "label">) => Effect.tryPromise({
        try: async () => {
          const existing = value.marker ? find(value.kind, value.marker) : undefined;
          if (existing) return existing;
          const row = { ...value, id: randomUUID(), runId, mrIid, provider: "fred" as const, at: Date.now() };
          await appendFile(path, `${JSON.stringify(row)}\n`, { mode: 0o600 });
          rows.push(row);
          return row;
        },
        catch: () => new GitLabError({ message: "Cannot persist local publication capture" }),
      });
      return {
        loadContext: () => Effect.succeed<ReviewContext | undefined>(context), isCurrent: () => Effect.succeed(true), ensureLabels: () => Effect.void,
        findSummary: (marker: string) => Effect.sync(() => { const row = find("summary", marker); return row ? { noteId: row.id } : undefined; }),
        publishSummary: (input: { marker: string; body: string }) => save({ kind: "summary", marker: input.marker, body: input.body }).pipe(Effect.map((row) => ({ noteId: row.id }))),
        publishDiscussion: (input: { marker: string; body: string }) => save({ kind: "finding", marker: input.marker, body: input.body }).pipe(Effect.map((row) => ({ discussionId: row.id, noteId: row.id }))),
        resolveDiscussion: (input: { marker: string; body: string }) => save({ kind: "resolve", marker: input.marker, body: input.body }).pipe(Effect.asVoid),
        setLabel: (label: ReviewVerdict) => save({ kind: "label", label }).pipe(Effect.asVoid),
      } satisfies GitLabReview;
    };
    return Layer.succeed(GitLab, { forMr: capture, forReview: capture });
  };
  return { layer, inspect: () => [...rows] };
});

export type Publications = Effect.Success<ReturnType<typeof openPublications>>;
