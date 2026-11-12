import { Effect } from "effect";
import { makeSkillCatalog } from "../skills/catalog";
import { makeCheckoutFilesystem } from "./filesystem";

// Walks a job's checkout once. Repository rules and both stages' tools share its file access and skill catalog.
export const openWorkspace = (checkoutPath: string) => Effect.gen(function* () {
  const filesystem = yield* makeCheckoutFilesystem(checkoutPath);
  return { filesystem, skills: yield* makeSkillCatalog(filesystem) };
});

export type Workspace = Effect.Success<ReturnType<typeof openWorkspace>>;
