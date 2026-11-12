import { noteMarker } from "@fred/contracts";
import { v } from "convex/values";
import { z } from "zod";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalAction, type ActionCtx } from "./_generated/server";
import { gitlabRest, retryableStatus, type GitLabRest } from "./gitlabRest";

const notes = z.array(z.object({ body: z.string() }));

class GitLabNoteError extends Error {
  constructor(readonly status: number) {
    super(`GitLab note request failed: ${status}`);
  }
}

async function send(rest: GitLabRest, ...request: Parameters<GitLabRest>) {
  const response = await rest(...request);
  if (!response.ok) throw new GitLabNoteError(response.status);
  return response;
}

async function alreadyPosted(rest: GitLabRest, path: string, marker: string) {
  let page = 1;
  while (true) {
    const response = await send(rest, `${path}?per_page=100&page=${page}`);
    if (notes.parse(await response.json()).some((note) => note.body.includes(marker))) return true;
    const next = response.headers.get("x-next-page");
    if (!next) return false;
    const nextPage = Number(next);
    if (!Number.isInteger(nextPage) || nextPage <= page) throw new Error("invalid GitLab pagination");
    page = nextPage;
  }
}

// Posts one note as the project's FRED bot, whatever the note's provider, unless a former attempt already posted it.
async function deliver(ctx: ActionCtx, note: Doc<"mrNotes">) {
  const credential = await ctx.runQuery(internal.projectTokens.credential, { gitlabProjectId: note.gitlabProjectId });
  const rest = credential && gitlabRest(credential.token);
  if (!rest) return { error: "GitLab configuration invalid or project not connected", retryable: false };
  const path = `projects/${encodeURIComponent(note.gitlabProjectId)}/merge_requests/${note.mrIid}/notes`;
  const marker = noteMarker(note._id);
  try {
    if (!(await alreadyPosted(rest, path, marker))) await send(rest, path, { method: "POST", json: { body: `${note.body}\n\n${marker}` } });
    return { retryable: false };
  } catch (error) {
    return error instanceof GitLabNoteError
      ? { error: error.message, retryable: retryableStatus(error.status) }
      : { error: "GitLab note request failed", retryable: true };
  }
}

export const postMrNote = internalAction({
  args: { noteId: v.id("mrNotes") },
  handler: async (ctx, args) => {
    const note = await ctx.runQuery(internal.mrNotes.get, args);
    if (!note || note.status !== "pending") return;
    const outcome = await deliver(ctx, note);
    await ctx.runMutation(internal.mrNotes.recordAttempt, { ...args, attempt: note.attempts + 1, ...outcome });
  },
});
