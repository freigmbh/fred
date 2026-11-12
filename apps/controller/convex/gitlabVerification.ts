import { z } from "zod";
import { gitlabRest, retryableStatus } from "./gitlabRest";

const gitlabId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const noteResponse = z.object({
  id: gitlabId,
  body: z.string(),
  system: z.boolean(),
  author: z.object({ id: gitlabId, bot: z.boolean().optional() }),
});
const mergeRequestResponse = z.object({
  iid: gitlabId,
  project_id: gitlabId,
  author: z.object({ id: gitlabId }),
});
const membershipResponse = z.object({ id: gitlabId, access_level: z.number().int().nonnegative() });

const MAINTAINER_ACCESS = 40;
const ignored = { kind: "ignored" } as const;
const retry = { kind: "retry" } as const;
const authorized = { kind: "authorized" } as const;
const denied = { kind: "denied" } as const;
const configurationFailure = { kind: "failed", reason: "configuration" } as const;

function requestFailure(status: number) {
  return retryableStatus(status) ? retry : { kind: "failed", reason: "gitlab" } as const;
}

// The command note as the webhook described it.
type CommandNote = { gitlabProjectId: string; mrIid: number; noteId: string; actorId: string; body: string };

// What verification needs: the project's FRED token, or null when the project is not connected, and every bot user ID to ignore.
type VerificationAccess = { token: string | null; botIds: string[] };

// Confirms through the project's FRED token that the note still exists unchanged and that its author is the MR author or a Maintainer.
// Resolves to authorized or denied; ignored for bot actors and gone or edited notes; retry or failed when GitLab or configuration fails.
export async function authorizeFindingCommand(note: CommandNote, access: VerificationAccess, fetcher: typeof fetch = fetch) {
  if (access.botIds.includes(note.actorId)) return ignored;
  const rest = access.token === null ? null : gitlabRest(access.token, fetcher);
  if (!rest) return configurationFailure;
  try {
    const projectPath = `projects/${note.gitlabProjectId}`;
    const mrPath = `${projectPath}/merge_requests/${note.mrIid}`;
    const currentNote = await rest(`${mrPath}/notes/${note.noteId}`);
    if (currentNote.status === 404) return ignored;
    if (!currentNote.ok) return requestFailure(currentNote.status);
    const found = noteResponse.parse(await currentNote.json());
    if (String(found.id) !== note.noteId || String(found.author.id) !== note.actorId
      || found.body !== note.body || found.system || found.author.bot) return ignored;

    const currentMr = await rest(mrPath);
    if (currentMr.status === 404) return ignored;
    if (!currentMr.ok) return requestFailure(currentMr.status);
    const mr = mergeRequestResponse.parse(await currentMr.json());
    if (String(mr.project_id) !== note.gitlabProjectId || mr.iid !== note.mrIid) return ignored;
    if (String(mr.author.id) === note.actorId) return authorized;

    const currentMember = await rest(`${projectPath}/members/all/${note.actorId}`);
    if (currentMember.status === 404) return denied;
    if (!currentMember.ok) return requestFailure(currentMember.status);
    const member = membershipResponse.parse(await currentMember.json());
    return String(member.id) === note.actorId && member.access_level >= MAINTAINER_ACCESS ? authorized : denied;
  } catch {
    return retry;
  }
}
