import { Effect } from "effect";
import type { z } from "zod";
import { catalogPage, diffPage, listDiffsInput, type DiffCatalog } from "../diffCatalog";
import type { StageInput } from "../provider";

export type DiffRead = z.infer<typeof diffPage> & { stage: StageInput<unknown>["stage"]; path: string };
export type CatalogRead = { stage: StageInput<unknown>["stage"]; cursor: number; nextCursor: number | null; bytes: number };

export function trackDiffReads(catalog: DiffCatalog, stage: StageInput<unknown>["stage"], reads: DiffRead[], listings: CatalogRead[]): DiffCatalog {
  const list: DiffCatalog["list"] = (input) => catalog.list(input).pipe(Effect.tap((text) => Effect.sync(() => {
    const page = catalogPage.parse(JSON.parse(text));
    listings.push({ stage, cursor: listDiffsInput.parse(input).cursor, nextCursor: page.nextCursor, bytes: Buffer.byteLength(text) });
  })));
  const read: DiffCatalog["read"] = (input) => catalog.read(input).pipe(Effect.tap((text) => Effect.sync(() => {
    const page = diffPage.safeParse(JSON.parse(text));
    if (page.success) reads.push({ ...page.data, stage, path: catalog.entries.find((entry) => entry.id === page.data.id)?.newPath ?? "" });
  })));
  return { ...catalog, list, read };
}

export function completeCatalogRead(reads: CatalogRead[], stage: CatalogRead["stage"]) {
  let cursor = 0;
  for (const page of reads.filter((read) => read.stage === stage)) {
    if (page.cursor !== cursor) continue;
    if (page.nextCursor === null) return true;
    cursor = page.nextCursor;
  }
  return false;
}

export function completeScopedRead(reads: DiffRead[], stage: DiffRead["stage"], path: string) {
  const pages = reads.filter((read) => read.stage === stage && read.path === path && read.range === "scope");
  let next = { line: 0, column: 0 };
  let continued = false;
  for (const page of pages) {
    const first = page.lines[0];
    if (!first || first.line !== next.line || first.column !== next.column) continue;
    if (page.nextCursor === null) return continued;
    continued ||= page.nextCursor.column > 0;
    next = page.nextCursor;
  }
  return false;
}
