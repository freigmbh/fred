import { strToU8, zip, type AsyncZippable } from "fflate";
import type { ExportManifest, ExportRow, ExportTable, TranscriptId } from "./api";

// One exportPage's rows as JSONL: one JSON document per line, every line ending in a newline, so pages concatenate.
export function jsonl(rows: readonly ExportRow[]) {
  return rows.map((row) => `${JSON.stringify(row)}\n`).join("");
}

// The IDs of the exported transcripts rows whose file is still stored, in row order. Rows carry `available` instead of a storage ID.
export function availableTranscripts(rows: readonly ExportRow[]) {
  return rows.flatMap((row) => (row.available === true && typeof row._id === "string" ? [row._id as TranscriptId] : []));
}

// The archive's file name in local time to the minute: fred-export-2026-10-04-2231.zip.
export function archiveName(at: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `fred-export-${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}.zip`;
}

// The contents of manifest.json. `tables` keeps the controller's order, so it reads like the manifest the UI started from.
// `fredVersion` is the deployed FRED that wrote the archive, null when no deployment stamped the UI.
export function archiveManifest({ formatVersion, fredVersion, exportedAt, tables, transcripts }: {
  formatVersion: ExportManifest["formatVersion"];
  fredVersion: string | null;
  exportedAt: Date;
  tables: readonly { name: ExportTable; rows: number }[];
  transcripts: number;
}) {
  return {
    formatVersion,
    fredVersion,
    exportedAt: exportedAt.toISOString(),
    tables: Object.fromEntries(tables.map(({ name, rows }) => [name, { rows }])),
    transcripts,
    notes: "pages are read one at a time; not a point-in-time snapshot",
  };
}

// Zips the export in a worker: manifest.json, tables/<table>.jsonl from their page chunks, and the gzipped transcript files
// stored as they are (level 0), since recompressing gzip gains nothing. Aborting `signal` terminates the zip and rejects.
export function buildArchive({ manifest, tables, transcripts, signal }: {
  manifest: ReturnType<typeof archiveManifest>;
  tables: readonly { name: ExportTable; chunks: readonly Uint8Array[] }[];
  transcripts: ReadonlyMap<TranscriptId, Uint8Array>;
  signal: AbortSignal;
}) {
  const files: AsyncZippable = {
    "manifest.json": strToU8(`${JSON.stringify(manifest, null, 2)}\n`),
    tables: Object.fromEntries(tables.map(({ name, chunks }) => [`${name}.jsonl`, concat(chunks)])),
    transcripts: Object.fromEntries([...transcripts].map(([id, bytes]) => [`${id}.json.gz`, [bytes, { level: 0 }]])),
  };
  return new Promise<Blob>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    let terminate: (() => void) | undefined;
    const onAbort = () => {
      terminate?.();
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    terminate = zip(files, { level: 6 }, (error, data) => {
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(new Blob([data], { type: "application/zip" }));
    });
  });
}

function concat(chunks: readonly Uint8Array[]) {
  const joined = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}
