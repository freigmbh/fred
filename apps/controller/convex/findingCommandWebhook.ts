import { z } from "zod";
import { internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";

const gitlabId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const command = z.object({
  action: z.enum(["dismiss", "undo"]),
  reference: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_:/-]{0,255}$/),
  reason: z.string().trim().min(1).max(2_000),
});
const noteEvent = z.object({
  object_kind: z.literal("note"),
  project: z.object({ id: gitlabId }),
  user: z.object({ id: gitlabId, bot: z.boolean().optional() }),
  object_attributes: z.object({
    id: gitlabId,
    note: z.string(),
    noteable_type: z.literal("MergeRequest"),
    action: z.literal("create"),
    system: z.boolean().optional(),
    author_id: gitlabId.optional(),
  }),
  merge_request: z.object({ iid: gitlabId }),
});

// The finding command in a note webhook, or undefined for any other event, a system or bot note, or a note that is not
// exactly one `fred dismiss|undo <reference> <reason>` line.
export function parseFindingCommandEvent(body: unknown) {
  const parsed = noteEvent.safeParse(body);
  if (!parsed.success) return undefined;
  const event = parsed.data;
  const note = event.object_attributes;
  if (note.system || event.user.bot || /[\r\n\u2028\u2029]/.test(note.note)) return undefined;
  if (note.author_id !== undefined && note.author_id !== event.user.id) return undefined;
  const match = /^fred (dismiss|undo) ([^ \t]+) (.+)$/u.exec(note.note);
  if (!match) return undefined;
  const parsedCommand = command.safeParse({ action: match[1], reference: match[2], reason: match[3] });
  if (!parsedCommand.success) return undefined;
  return {
    ...parsedCommand.data,
    gitlabProjectId: String(event.project.id),
    mrIid: event.merge_request.iid,
    noteId: String(note.id),
    actorId: String(event.user.id),
    body: note.note,
  };
}

// Stores a receipt for a finding command note and answers the webhook. Undefined when the body is not a finding command.
export async function handleFindingCommand(ctx: ActionCtx, body: unknown): Promise<Response | undefined> {
  const event = parseFindingCommandEvent(body);
  if (!event) return undefined;
  const { gitlabProjectId, noteId, ...command } = event;
  return Response.json(await ctx.runMutation(internal.findingCommandRequests.receive, { gitlabProjectId, noteId, command }));
}
