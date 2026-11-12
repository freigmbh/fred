import { useEffect, useRef, useState, type ReactNode } from "react";
import { Box, BoxFooter, BoxHeading, Page, PageLoading, PageTitle, Row, Section, Tile, Tiles } from "@/components/group";
import { Empty, Status } from "@/components/marks";
import { Button } from "@/components/ui/button";
import { Progress as ProgressRoot, ProgressLabel } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAdminQuery } from "@/lib/admin";
import { api } from "@/lib/api";
import { attempts, useDataExport, type ExportState, type Progress, type RunningPhase, type StoppedAt } from "@/lib/data-export";
import { count, duration, fileSize } from "@/lib/format";

type Exporter = ReturnType<typeof useDataExport>;
type TableProgress = Progress["tables"][number];

const warning = "Contains source code from reviewed MRs and developer names, usernames, and GitLab IDs. Store it like the repositories themselves.";

export function Export() {
  const manifest = useAdminQuery(api.admin.exportManifest, {});
  const exporter = useDataExport(manifest);
  const elapsed = useElapsed(exporter);
  const aside = usePanelFocus(exporter.state);
  if (!manifest) return <PageLoading />;
  const { state } = exporter;
  const tables = state.phase === "idle" ? manifest.tables.map((name) => ({ name, status: "waiting" as const, pages: 0, rows: 0, bytes: 0 })) : state.progress.tables;
  const files = state.phase === "idle" || state.progress.files.total === null ? null : state.progress.files.total - state.progress.files.missing;
  return (
    <Page>
      <PageTitle title="Export" fact={`${tables.length} ${tables.length === 1 ? "table" : "tables"} · one zip`} />
      <Box><ExportStats state={state} tableCount={tables.length} elapsed={elapsed} /></Box>
      <div className="items-start gap-x-4 lg:flex">
        <Section title={`Tables · ${tables.length}`} className="lg:min-w-0 lg:flex-1">
          <TablesTable tables={tables} reason={state.phase === "failed" ? state.reason : null} />
        </Section>
        <section ref={aside} className="mt-4 lg:sticky lg:top-5 lg:w-95 lg:shrink-0">
          <p role="status" aria-live="polite" className="sr-only">{announcement(state)}</p>
          <ExportPanel exporter={exporter} tableCount={tables.length} elapsed={elapsed} files={files} />
        </section>
      </div>
    </Page>
  );
}

// Moves focus to the aside's `data-focus-target` control whenever the panel swaps between idle, running, failed, and done,
// since the button that was pressed is gone. Returns the ref for the aside. The first render leaves focus alone.
function usePanelFocus(state: ExportState) {
  const aside = useRef<HTMLElement>(null);
  const kind = state.phase === "tables" || state.phase === "files" || state.phase === "zipping" ? "running" : state.phase;
  const previous = useRef(kind);
  useEffect(() => {
    if (previous.current === kind) return;
    previous.current = kind;
    aside.current?.querySelector<HTMLElement>("[data-focus-target]")?.focus();
  }, [kind]);
  return aside;
}

// What the live region says after each transition. Phase changes only, so progress ticks stay quiet.
function announcement(state: ExportState) {
  switch (state.phase) {
    case "idle": return state.ended === "cancelled" ? "Export cancelled. Nothing was saved." : state.ended === "discarded" ? "Export discarded." : state.ended === "restarted" ? "Ready for a new export." : "";
    case "tables": return "Export running. Reading tables.";
    case "files": return "Tables read. Downloading transcript files.";
    case "zipping": return "Building the zip.";
    case "failed": return `Export stopped at ${stoppedLabel(state.stoppedAt)}: ${state.reason}. What was read is kept; retry or discard.`;
    case "done": return state.archive ? `Export saved as ${state.archive.fileName}.` : "Nothing to export yet. FRED has not stored a review.";
  }
}

// Milliseconds since the export started, ticking each second while it runs and frozen once it stops. Null when idle.
function useElapsed({ state, running }: Exporter) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  if (state.phase === "idle") return null;
  return ("endedAt" in state ? state.endedAt : now) - state.progress.startedAt;
}

function totals({ tables, files }: Progress) {
  return {
    tablesDone: tables.filter((table) => table.status === "done").length,
    rows: tables.reduce((sum, table) => sum + table.rows, 0),
    bytes: tables.reduce((sum, table) => sum + table.bytes, 0) + files.bytes,
  };
}

function ExportStats({ state, tableCount, elapsed }: { state: ExportState; tableCount: number; elapsed: number | null }) {
  if (state.phase === "idle") {
    const value = tableCount === 0 ? "0" : "·";
    return <StatStrip tables={value} rows={value} files={value} fetched="·" />;
  }
  const { files } = state.progress;
  const { tablesDone, rows, bytes } = totals(state.progress);
  return (
    <StatStrip
      tables={`${tablesDone} / ${tableCount}`}
      rows={state.phase === "failed" ? `${count(rows)} kept` : count(rows)}
      files={files.total === null ? "waiting" : `${count(files.fetched)} / ${count(files.total)}`}
      filesSub={files.missing ? `${count(files.missing)} deleted during export` : undefined}
      fetched={`${fileSize(bytes)} · ${duration(elapsed)}`}
    />
  );
}

function StatStrip({ tables, rows, files, filesSub, fetched }: { tables: string; rows: string; files: string; filesSub?: string | undefined; fetched: string }) {
  return (
    <Tiles columns={4}>
      <Tile label="tables" value={tables} />
      <Tile label="rows fetched" value={rows} />
      <Tile label="transcript files" value={files} sub={filesSub} />
      <Tile label="fetched · elapsed" value={fetched} />
    </Tiles>
  );
}

function TablesTable({ tables, reason }: { tables: readonly TableProgress[]; reason: string | null }) {
  if (tables.length === 0) return <Empty>Nothing to export. The controller lists no tables.</Empty>;
  return (
    <Table>
      <TableHeader><TableRow><TableHead>Table</TableHead><TableHead className="text-right">Rows</TableHead><TableHead className="text-right">Size</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
      <TableBody>
        {tables.map((table) => (
          <TableRow key={table.name} className={table.status === "fetching" || table.status === "failed" ? "bg-muted/50" : undefined}>
            <TableCell className="font-mono text-xs">{table.name}</TableCell>
            <TableCell className="text-right tabular-nums">{table.status === "waiting" ? "·" : count(table.rows)}</TableCell>
            <TableCell className="text-right tabular-nums">{table.status === "waiting" ? "·" : fileSize(table.bytes)}</TableCell>
            <TableCell><TableStatus table={table} reason={reason} /></TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function TableStatus({ table, reason }: { table: TableProgress; reason: string | null }) {
  if (table.status === "waiting") return <span className="text-faint">waiting</span>;
  if (table.status === "done") return <span className="text-muted-foreground">done</span>;
  if (table.status === "fetching") return <span><Status tone="ok">fetching</Status> <span className="text-faint">· page {table.pages + 1}</span></span>;
  return <span className="inline-block max-w-80 truncate align-middle" title={reason ?? undefined}><Status tone="bad">failed · {reason}</Status></span>;
}

// The "Archive" box: its contents as rows, the phase's actions in the footer.
function ExportPanel({ exporter, tableCount, elapsed, files }: { exporter: Exporter; tableCount: number; elapsed: number | null; files: number | null }) {
  const { state } = exporter;
  const contents = (
    <Row label="Contents" align="start">
      <ul className="font-mono text-xs leading-loose text-muted-foreground">
        <li>manifest.json</li>
        <li>tables/&lt;table&gt;.jsonl <span className="text-faint">× {count(tableCount)}</span></li>
        <li>transcripts/&lt;id&gt;.json.gz <span className="text-faint">× {files === null ? "·" : count(files)}</span></li>
      </ul>
    </Row>
  );
  switch (state.phase) {
    case "idle": return <IdlePanel empty={tableCount === 0} onStart={exporter.start}>{contents}</IdlePanel>;
    case "failed": return <FailedPanel progress={state.progress} stoppedAt={state.stoppedAt} reason={state.reason} onRetry={exporter.retry} onDiscard={() => exporter.reset("discarded")}>{contents}</FailedPanel>;
    case "done": return <DonePanel progress={state.progress} archive={state.archive} elapsed={elapsed} onSave={exporter.save} onReset={() => exporter.reset("restarted")}>{contents}</DonePanel>;
    default: return <ProgressPanel phase={state.phase} progress={state.progress} onCancel={() => exporter.reset("cancelled")}>{contents}</ProgressPanel>;
  }
}

function Panel({ status, actions, children }: { status?: ReactNode; actions: ReactNode; children: ReactNode }) {
  return (
    <>
      <BoxHeading title="Archive" />
      <Box>
        {children}
        <BoxFooter status={status}>{actions}</BoxFooter>
      </Box>
    </>
  );
}

function IdlePanel({ empty, onStart, children }: { empty: boolean; onStart: () => void; children: ReactNode }) {
  return (
    <Panel actions={<Button data-focus-target disabled={empty} onClick={onStart}>Export all data</Button>}>
      {children}
      <Row label="Includes" align="start"><span className="text-bordeaux">{warning}</span></Row>
      {empty ? null : <Row label="Takes">A few minutes <span className="text-faint">· keep this tab open</span></Row>}
    </Panel>
  );
}

function ProgressPanel({ phase, progress, onCancel, children }: { phase: RunningPhase; progress: Progress; onCancel: () => void; children: ReactNode }) {
  const { files, tables } = progress;
  const { tablesDone } = totals(progress);
  const filesSettled = files.fetched + files.missing;
  return (
    <Panel status={<span className="text-faint">{phase === "zipping" ? "Building the zip. Keep this tab open." : "Leaving the page cancels the export."}</span>}
      actions={<Button data-focus-target variant="outline" onClick={onCancel}>Cancel</Button>}>
      {children}
      <Row label="Tables"><ProgressBar value={`${count(tablesDone)} of ${count(tables.length)}`} fraction={tablesDone / tables.length} /></Row>
      <Row label={<span className={files.total === null ? "text-faint" : undefined}>Transcript files</span>}>
        <ProgressBar value={files.total === null ? "after tables" : `${count(filesSettled)} of ${count(files.total)}`} fraction={files.total === null ? 0 : files.total === 0 ? 1 : filesSettled / files.total} />
      </Row>
    </Panel>
  );
}

const stoppedLabel = (stoppedAt: StoppedAt) => (stoppedAt.step === "tables" ? stoppedAt.table : stoppedAt.step === "files" ? "transcript files" : "the zip");

function FailedPanel({ progress, stoppedAt, reason, onRetry, onDiscard, children }: { progress: Progress; stoppedAt: StoppedAt; reason: string; onRetry: () => void; onDiscard: () => void; children: ReactNode }) {
  const { files, tables } = progress;
  const { tablesDone } = totals(progress);
  const atTables = stoppedAt.step === "tables";
  const filesSettled = files.fetched + files.missing;
  const filesTotal = files.total ?? 0;
  const kept = atTables ? `The ${count(tablesDone)} finished tables are kept in this tab.` : `The ${count(tables.length)} tables and ${count(files.fetched)} transcript files are kept in this tab.`;
  return (
    <Panel actions={<><Button variant="outline" onClick={onDiscard}>Discard</Button><Button data-focus-target onClick={onRetry}>{stoppedAt.step === "zip" ? "Retry the zip" : `Retry from ${stoppedLabel(stoppedAt)}`}</Button></>}>
      {children}
      <Row label={<Status tone="bad">Stopped</Status>} sub={<span className="text-bordeaux">{stoppedAt.step === "zip" ? `Could not build the zip: ${reason}.` : `Failed after ${attempts} attempts: ${reason}.`} {kept}</span>}>
        <ProgressBar value={`at ${stoppedLabel(stoppedAt)} · ${atTables ? `${count(tablesDone)} of ${count(tables.length)}` : `${count(filesSettled)} of ${count(filesTotal)}`}`}
          fraction={atTables ? tablesDone / tables.length : filesTotal === 0 ? 1 : filesSettled / filesTotal} />
      </Row>
    </Panel>
  );
}

function DonePanel({ progress, archive, elapsed, onSave, onReset, children }: { progress: Progress; archive: Extract<ExportState, { phase: "done" }>["archive"]; elapsed: number | null; onSave: () => void; onReset: () => void; children: ReactNode }) {
  if (!archive) {
    return (
      <Panel status={<span className="text-faint">Nothing to export yet. FRED has not stored a review.</span>} actions={<Button data-focus-target variant="ghost" onClick={onReset}>Start over</Button>}>
        {children}
      </Panel>
    );
  }
  return (
    <Panel actions={<><Button variant="ghost" onClick={onReset}>Start over</Button><Button data-focus-target variant="outline" onClick={onSave}>Save again</Button></>}>
      {children}
      <Row label={<Status tone="ok">Saved</Status>} sub={`${fileSize(archive.blob.size)} · ${count(totals(progress).rows)} rows · ${count(progress.files.fetched)} transcripts · ${duration(elapsed)}`}>
        <span className="block truncate font-mono text-xs" title={archive.fileName}>{archive.fileName}</span>
      </Row>
    </Panel>
  );
}

// A Progress labelled with `value`, which screen readers also read instead of the percentage. `fraction` runs from 0 to 1.
function ProgressBar({ value, fraction }: { value: string; fraction: number }) {
  return (
    <ProgressRoot value={Math.round(Math.min(1, Math.max(0, fraction)) * 100)} getAriaValueText={() => value}>
      <ProgressLabel className="tabular-nums">{value}</ProgressLabel>
    </ProgressRoot>
  );
}
