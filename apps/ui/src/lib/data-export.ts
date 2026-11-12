import { useBlocker } from "@tanstack/react-router";
import { useConvex } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { errorText, isErrorCode, signOutIfRejected } from "./admin";
import { api, type ExportManifest, type ExportTable, type TranscriptId } from "./api";
import { archiveManifest, archiveName, availableTranscripts, buildArchive, jsonl } from "./archive";
import { fredVersion } from "./version";
import { saveFile } from "./save-file";
import { useAdminSecret } from "./secret";

// Tries per controller call before the export stops, and transcript downloads in flight at once.
export const attempts = 3;
const fileConcurrency = 4;

type TableStatus = "waiting" | "fetching" | "done" | "failed";
export type RunningPhase = "tables" | "files" | "zipping";
type Archive = { blob: Blob; fileName: string };

// Where a failed export stopped, which is where Retry continues.
export type StoppedAt = { step: "tables"; table: ExportTable } | { step: "files" } | { step: "zip" };

// A copy of a job's counters for rendering. `files.total` stays null until every table is read.
export type Progress = ReturnType<typeof snapshot>;

// How an export left for idle, so the page can announce it. Null before the first export.
export type IdleReason = "cancelled" | "discarded" | "restarted";

// The export as the Export page renders it. Idle until started; running through tables, transcript files, and the zip; then
// failed with everything read so far kept for Retry, or done with the saved archive, null when no table had a row.
export type ExportState =
  | { phase: "idle"; ended: IdleReason | null }
  | { phase: RunningPhase; progress: Progress }
  | { phase: "failed"; progress: Progress; endedAt: number; stoppedAt: StoppedAt; reason: string }
  | { phase: "done"; progress: Progress; endedAt: number; archive: Archive | null };

// Everything one export has read. Kept across a failure so Retry continues at the failed page or file; dropped on Cancel,
// Discard, and Start over. Mutated in place by runExport and copied into state through snapshot.
type Job = ReturnType<typeof newJob>;

function newJob(manifest: ExportManifest) {
  const startedAt = Date.now();
  return {
    manifest,
    exportedAt: new Date(startedAt),
    startedAt,
    tables: new Map(manifest.tables.map((name) => [name, { status: "waiting" as TableStatus, pages: 0, rows: 0, bytes: 0, cursor: null as string | null, chunks: [] as Uint8Array[] }])),
    transcriptIds: [] as TranscriptId[],
    filesTotal: null as number | null,
    files: new Map<TranscriptId, Uint8Array>(),
    fileBytes: 0,
    missing: new Set<TranscriptId>(),
  };
}

function snapshot(job: Job) {
  return {
    startedAt: job.startedAt,
    tables: [...job.tables].map(([name, { status, pages, rows, bytes }]) => ({ name, status, pages, rows, bytes })),
    files: { fetched: job.files.size, total: job.filesTotal, missing: job.missing.size, bytes: job.fileBytes },
  };
}

// Runs the data export for the Export page. `start` reads every table the manifest lists page by page, then every available
// transcript file, zips them, and saves the zip. `retry` continues a failed export, `reset` cancels or discards one and
// returns to idle saying why, `save` downloads a finished archive again. Starting always stops a previous run first, and
// cancelling unwinds at once without waiting for the request in flight. Leaving the page while running, or while a failed
// export holds its data for retry, asks first and then discards it.
export function useDataExport(manifest: ExportManifest | undefined) {
  const client = useConvex();
  const { secret } = useAdminSecret();
  const [state, setState] = useState<ExportState>({ phase: "idle", ended: null });
  const job = useRef<Job | null>(null);
  const abort = useRef<AbortController | null>(null);
  const running = state.phase === "tables" || state.phase === "files" || state.phase === "zipping";
  const holding = running || state.phase === "failed";
  const leaveWarning = running ? "Leave this page? The export stops and its data is discarded." : "Leave this page? The data kept for retry is discarded.";

  useBlocker({ shouldBlockFn: () => !window.confirm(leaveWarning), enableBeforeUnload: holding, disabled: !holding });
  useEffect(() => () => abort.current?.abort(), []);

  function begin(current: Job) {
    if (!secret) return;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    job.current = current;
    const publish = (phase: RunningPhase) => setState({ phase, progress: snapshot(current) });
    runExport({ client, adminSecret: secret, job: current, signal: controller.signal, publish }).then(
      (archive) => {
        if (controller.signal.aborted) return;
        if (archive) saveFile(archive.blob, archive.fileName);
        job.current = null;
        setState({ phase: "done", progress: snapshot(current), endedAt: Date.now(), archive });
      },
      (cause: unknown) => {
        if (controller.signal.aborted) return;
        if (signOutIfRejected(cause)) return;
        const stoppedAt = markStopped(current);
        setState({ phase: "failed", progress: snapshot(current), endedAt: Date.now(), stoppedAt, reason: errorText(cause) });
      },
    );
  }

  return {
    state,
    running,
    start() {
      if (manifest && !running) begin(newJob(manifest));
    },
    // The time spent stopped does not count as elapsed.
    retry() {
      if (state.phase !== "failed" || !job.current) return;
      job.current.startedAt += Date.now() - state.endedAt;
      begin(job.current);
    },
    reset(ended: IdleReason) {
      abort.current?.abort();
      job.current = null;
      setState({ phase: "idle", ended });
    },
    save() {
      if (state.phase === "done" && state.archive) saveFile(state.archive.blob, state.archive.fileName);
    },
  };
}

type RunContext = { client: ReturnType<typeof useConvex>; adminSecret: string; job: Job; signal: AbortSignal; publish: (phase: RunningPhase) => void };

// Reads every table not yet done, continuing a failed one at its cursor, then fetches the transcript files not yet fetched,
// then zips. Returns null without zipping when no table had a row. Throws the cause of the first call that ran out of tries.
async function runExport(context: RunContext) {
  const { client, adminSecret, job, signal, publish } = context;
  const encoder = new TextEncoder();
  for (const [name, table] of job.tables) {
    if (table.status === "done") continue;
    table.status = "fetching";
    publish("tables");
    while (table.status === "fetching") {
      const page = await request(() => client.query(api.admin.exportPage, { adminSecret, table: name, cursor: table.cursor }), signal);
      const chunk = encoder.encode(jsonl(page.rows));
      table.chunks.push(chunk);
      table.pages += 1;
      table.rows += page.rows.length;
      table.bytes += chunk.byteLength;
      table.cursor = page.continueCursor;
      if (name === "transcripts") job.transcriptIds.push(...availableTranscripts(page.rows));
      if (page.isDone) table.status = "done";
      publish("tables");
    }
  }
  const tables = [...job.tables].map(([name, table]) => ({ name, ...table }));
  job.filesTotal = job.transcriptIds.length;
  if (tables.every((table) => table.rows === 0)) return null;
  publish("files");
  await fetchFiles(context);
  publish("zipping");
  const manifest = archiveManifest({ formatVersion: job.manifest.formatVersion, fredVersion: await fredVersion(), exportedAt: job.exportedAt, tables, transcripts: job.files.size });
  const blob = await buildArchive({ manifest, tables, transcripts: job.files, signal });
  return { blob, fileName: archiveName(job.exportedAt) };
}

// Downloads the pending transcript files a few at a time. A file deleted since its row was read is left out and counted as
// missing. The first other failure stops new downloads, waits for those in flight, and is thrown.
async function fetchFiles({ client, adminSecret, job, signal, publish }: RunContext) {
  const pending = job.transcriptIds.filter((id) => !job.files.has(id) && !job.missing.has(id));
  let stopped = false;
  async function worker() {
    while (!stopped) {
      const transcriptId = pending.shift();
      if (transcriptId === undefined) return;
      try {
        const { bytes } = await request(() => client.action(api.admin.downloadTranscript, { adminSecret, transcriptId }), signal);
        job.files.set(transcriptId, new Uint8Array(bytes));
        job.fileBytes += bytes.byteLength;
      } catch (cause) {
        if (!isErrorCode(cause, "transcript_unavailable")) {
          stopped = true;
          throw cause;
        }
        job.missing.add(transcriptId);
      }
      publish("files");
    }
  }
  const results = await Promise.allSettled(Array.from({ length: fileConcurrency }, worker));
  const failure = results.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
}

// Runs one controller call with up to `attempts` tries, waiting a second longer before each retry. A rejected secret and a
// deleted transcript are final at once. Throws the abort reason as soon as the export is cancelled, even mid-request.
async function request<T>(call: () => Promise<T>, signal: AbortSignal) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await abortable(call(), signal);
    } catch (cause) {
      signal.throwIfAborted();
      if (attempt >= attempts || isErrorCode(cause, "unauthorized") || isErrorCode(cause, "transcript_unavailable")) throw cause;
    }
    await pause(attempt * 1000, signal);
  }
}

// Settles with `promise`, or rejects with the abort reason as soon as `signal` aborts. The abandoned promise's result is dropped.
function abortable<T>(promise: Promise<T>, signal: AbortSignal) {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function pause(ms: number, signal: AbortSignal) {
  return abortable(new Promise<void>((resolve) => setTimeout(resolve, ms)), signal);
}

// Marks the table that was being read as failed and says where Retry continues.
function markStopped(job: Job): StoppedAt {
  for (const [name, table] of job.tables) {
    if (table.status === "fetching") {
      table.status = "failed";
      return { step: "tables", table: name };
    }
  }
  const pending = job.transcriptIds.length - job.files.size - job.missing.size;
  return job.filesTotal !== null && pending === 0 ? { step: "zip" } : { step: "files" };
}
