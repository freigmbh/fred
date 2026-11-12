import { cn } from "cn";
import { useAction } from "convex/react";
import type { FunctionArgs } from "convex/server";
import { useState } from "react";
import { ExpandableRow, useOneOpenRow } from "@/components/expandable-row";
import { Box, MoreRow, Page, PageTitle, Tile, Tiles } from "@/components/group";
import { ModelsFilter } from "@/components/models-filter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption, SelectPrefix } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Empty, Facts, Loading, ModelChip, ModelMark, MrLink, OwnerName, ProviderMark, SectionLabel, snapshotFacts, Status, type FactEntry } from "@/components/marks";
import { useAdminCall, useAdminQuery } from "@/lib/admin";
import { api, providerLabel, providers, type FinishedStatus, type Provider, type Review as ReviewData, type ReviewStats, type Reviews as ReviewsData } from "@/lib/api";
import { finishedStatuses, finishedStatusLabel, findingsText, jobStatusTone, mrLabel, severityLabel, shortSha, stageModelsText, usageText, workerText } from "@/lib/display";
import { compact, duration, fileSize, percent, time, usd } from "@/lib/format";
import { saveFile } from "@/lib/save-file";
import { useWindowStart } from "@/lib/time";

type Row = ReviewsData["rows"][number];
type Transcript = NonNullable<ReviewData>["transcripts"][number];
type Filters = Omit<FunctionArgs<typeof api.admin.reviews>, "adminSecret">;
type Scope = Omit<FunctionArgs<typeof api.admin.reviewStats>, "adminSecret">;
type StatusFilter = "all" | FinishedStatus;
type ProviderFilter = "all" | Provider;

const statuses = ["all", ...finishedStatuses] as const satisfies readonly StatusFilter[];
const statusLabel: Record<StatusFilter, string> = { all: "All", ...finishedStatusLabel };
const providerFilters = ["all", ...providers] as const satisfies readonly ProviderFilter[];
const ranges = [{ id: "7", label: "7 days", days: 7 }, { id: "30", label: "30 days", days: 30 }, { id: "90", label: "90 days", days: 90 }, { id: "all", label: "all time", days: null }] as const;
const pageLimit = 200;

// The filter bar's state in the shapes admin.reviews and admin.reviewStats take. `scope` holds the filters the stats honour:
// window, status, and bot.
function useFilters() {
  const [status, setStatus] = useState<StatusFilter>("all");
  const [provider, setProvider] = useState<ProviderFilter>("all");
  const [rangeId, setRange] = useState<(typeof ranges)[number]["id"]>("30");
  const [models, setModels] = useState<string[]>([]);
  const [limit, setLimit] = useState(50);
  const range = ranges.find((option) => option.id === rangeId) ?? ranges[1];
  const since = useWindowStart(range.days);
  const scope: Scope = {
    ...(since === null ? {} : { since }),
    ...(status === "all" ? {} : { statuses: [status] }),
    ...(provider === "all" ? {} : { provider }),
  };
  const args: Filters = { ...scope, limit, ...(models.length ? { models } : {}) };
  const toggleModel = (model: string) => setModels(models.includes(model) ? models.filter((own) => own !== model) : [...models, model].sort());
  return { status, setStatus, provider, setProvider, range, setRange, models, setModels, toggleModel, limit, setLimit, scope, args, active: status !== "all" || provider !== "all" || models.length > 0 };
}

type FilterState = ReturnType<typeof useFilters>;

// Matches the search box against what identifies a review to a person: project, MR number, owner, and head SHA.
function matchesSearch(row: Row, search: string) {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [row.project?.path, `!${row.mrIid}`, row.developer?.displayName, row.developer?.username, row.headSha].filter(Boolean).join(" ").toLowerCase();
  return haystack.includes(needle);
}

export function Reviews() {
  const filters = useFilters();
  const [search, setSearch] = useState("");
  const reviews = useAdminQuery(api.admin.reviews, filters.args);
  // The stats cannot apply the model filter or the search box, so they step aside while either narrows the table.
  const tableOnly = filters.models.length > 0 || search.trim() !== "";
  const stats = useAdminQuery(api.admin.reviewStats, tableOnly ? "skip" : filters.scope);
  const visible = reviews?.rows.filter((row) => matchesSearch(row, search)) ?? [];
  const window = filters.range.days === null ? "all time" : `last ${filters.range.label}`;
  const filtered = filters.active || search.trim() !== "";
  const empty = filtered ? "No reviews match these filters." : filters.range.days === null ? "No finished reviews yet." : `No finished reviews in the ${window}.`;
  return (
    <Page>
      <PageTitle title="Reviews" fact={reviews ? `${visible.length} shown · ${window}` : undefined} />
      <FilterBar filters={filters} models={reviews?.models ?? []} search={search} onSearch={setSearch} />
      {stats ? <Box className="mt-4"><Summary stats={stats} /></Box> : null}
      <Box className="mt-4">
        {reviews ? <ReviewsTable rows={visible} gitlabUrl={reviews.gitlabUrl} empty={empty} /> : <Loading />}
        {reviews?.hasMore && filters.limit < pageLimit ? <MoreRow onClick={() => filters.setLimit(pageLimit)}>Show more</MoreRow> : null}
        {reviews?.hasMore && filters.limit >= pageLimit ? <MoreRow>Older reviews exist beyond the newest {pageLimit}. Narrow the window or the filters to reach them.</MoreRow> : null}
      </Box>
    </Page>
  );
}

function FilterBar({ filters, models, search, onSearch }: { filters: FilterState; models: string[]; search: string; onSearch: (value: string) => void }) {
  const options = [...new Set([...models, ...filters.models])].sort();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <NativeSelect aria-label="Status" value={filters.status} onChange={(event) => filters.setStatus(event.target.value as StatusFilter)}
        face={<><SelectPrefix>Status</SelectPrefix>{statusLabel[filters.status]}</>}>
        {statuses.map((value) => <NativeSelectOption key={value} value={value}>{statusLabel[value]}</NativeSelectOption>)}
      </NativeSelect>
      <NativeSelect aria-label="Bot" value={filters.provider} onChange={(event) => filters.setProvider(event.target.value as ProviderFilter)}
        face={<><SelectPrefix>Bot</SelectPrefix>{filters.provider === "all" ? "All" : providerLabel[filters.provider]}</>}>
        {providerFilters.map((value) => <NativeSelectOption key={value} value={value}>{value === "all" ? "All" : providerLabel[value]}</NativeSelectOption>)}
      </NativeSelect>
      <ModelsFilter options={options} selected={filters.models} onToggle={filters.toggleModel} onClear={() => filters.setModels([])} />
      <Tabs value={filters.range.id} onValueChange={(value) => filters.setRange(value as (typeof ranges)[number]["id"])}>
        <TabsList aria-label="Window">{ranges.map((option) => <TabsTrigger key={option.id} value={option.id}>{option.label}</TabsTrigger>)}</TabsList>
      </Tabs>
      <Input type="search" value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Project, MR, owner, SHA" aria-label="Search reviews" className="w-56 sm:ml-auto" />
    </div>
  );
}

// Totals over the whole window, status, and bot from admin.reviewStats, so loading more rows never moves them.
function Summary({ stats }: { stats: ReviewStats }) {
  return (
    <Tiles columns={7}>
      <Tile label="reviews" value={stats.reviews} />
      <Tile label="done" value={stats.done} />
      <Tile label="failed" value={stats.failed} tone={stats.failed ? "bad" : undefined} />
      <Tile label="clean" value={percent(stats.clean, stats.done)} />
      <Tile label="findings" value={stats.findings} />
      <Tile label="median run" value={duration(stats.runP50Ms)} />
      <Tile label="spent" value={usd(stats.costUsd)} />
    </Tiles>
  );
}

function ReviewsTable({ rows, gitlabUrl, empty }: { rows: Row[]; gitlabUrl: string | null; empty: string }) {
  const rowToggle = useOneOpenRow<Row["jobId"]>();
  if (rows.length === 0) return <Empty>{empty}</Empty>;
  return (
    <Table>
      <TableHeader>
        <TableRow><TableHead>Review</TableHead><TableHead>Status</TableHead><TableHead>Outcome</TableHead><TableHead>Models</TableHead><TableHead className="text-right">Wait</TableHead><TableHead className="text-right">Run</TableHead><TableHead className="text-right">Spent</TableHead><TableHead>When</TableHead><TableHead /></TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <ExpandableRow key={row.jobId} {...rowToggle(row.jobId)} label={`Review details for ${mrLabel(row.project, row.mrIid)}, ${time(row.endedAt)}`} detail={<ReviewDetail row={row} />}>
            <TableCell>
              <span className="block font-medium"><MrLink project={row.project} mrIid={row.mrIid} gitlabUrl={gitlabUrl} /></span>
              <span className="block text-xs text-faint"><OwnerName developer={row.developer} /> · <span className="font-mono">{shortSha(row.headSha)}</span> · <ProviderMark provider={row.provider} /></span>
            </TableCell>
            <TableCell><StatusMark status={row.status} /></TableCell>
            <TableCell className="max-w-72"><Outcome row={row} /></TableCell>
            <TableCell><Models row={row} /></TableCell>
            <TableCell className="text-right tabular-nums text-faint">{row.claimedAt === null ? "·" : duration(row.claimedAt - row.createdAt)}</TableCell>
            <TableCell className="text-right tabular-nums">{row.claimedAt === null ? "·" : duration(row.endedAt - row.claimedAt)}</TableCell>
            <TableCell className="text-right tabular-nums whitespace-nowrap">{usd(row.costUsd)}{row.usageIncomplete ? <span className="ml-1.5 text-xs text-warning">· incomplete</span> : null}</TableCell>
            <TableCell className="tabular-nums text-muted-foreground">{time(row.endedAt)}</TableCell>
          </ExpandableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function StatusMark({ status }: { status: Row["status"] }) {
  const tone = jobStatusTone[status];
  return tone ? <Status tone={tone}>{status}</Status> : <span className="text-faint">{status}</span>;
}

// One line for what came out of the review: the verdict with finding counts, or the reason it stopped.
function Outcome({ row }: { row: Row }) {
  if (row.status === "done") {
    if (row.verdict === "clean") return <span>clean</span>;
    const { rejected, duplicate } = row.findings;
    const dropped = [[rejected, "rejected"], [duplicate, "duplicate"]].filter(([count]) => count).map(([count, label]) => `${count} ${label}`);
    return <span>{findingsText(row.findings) || (row.verdict === "findings" ? "findings" : "·")}{dropped.length ? <span className="ml-2 text-faint">· {dropped.join(" · ")}</span> : null}</span>;
  }
  if (row.status === "superseded") return <span className="text-faint">newer push</span>;
  if (row.status === "skipped") return <span className="text-faint">unchanged since last review</span>;
  return <span className="block truncate" title={row.reason ?? undefined}>{row.failureReason && row.status === "failed" ? <span className="text-faint">{row.failureReason} · </span> : null}{row.reason ?? "·"}</span>;
}

// Every model that touched the job, as chips. The title carries the stage selections with their effort when the job has them.
function Models({ row }: { row: Row }) {
  const title = row.stageModels ? stageModelsText(row.stageModels) : row.models.join("\n");
  if (row.models.length === 0) return <span className="text-faint">·</span>;
  return <span className="inline-flex flex-wrap gap-1" title={title}>{row.models.map((model) => <ModelChip key={model} model={model} title={title} />)}</span>;
}

function ReviewDetail({ row }: { row: Row }) {
  const detail = useAdminQuery(api.admin.review, { jobId: row.jobId });
  if (detail === undefined) return <Loading className="p-0 text-xs" />;
  if (detail === null) return <Empty className="p-0 text-xs">This job no longer exists.</Empty>;
  return (
    <div className="grid gap-x-10 gap-y-4 text-xs lg:grid-cols-2">
      <ReviewFacts row={row} detail={detail} />
      <UsageTable usage={detail.usage} />
      <div className="lg:col-span-2"><TranscriptList collecting={detail.collectTranscripts} transcripts={detail.transcripts} /></div>
      <div className="lg:col-span-2"><FindingsList findings={detail.findings} /></div>
      {detail.summary ? <div className="lg:col-span-2"><SectionLabel>summary</SectionLabel><pre className="whitespace-pre-wrap font-sans text-muted-foreground">{detail.summary}</pre></div> : null}
    </div>
  );
}

function ReviewFacts({ row, detail }: { row: Row; detail: NonNullable<ReviewData> }) {
  const entries: FactEntry[] = [
    ["job", <span className="font-mono">{row.jobId}</span>],
    ["head", <span className="font-mono">{shortSha(row.headSha, 12)}{row.previousReviewedSha ? <span className="text-faint"> · re-review of {shortSha(row.previousReviewedSha, 12)}</span> : null}</span>],
    ["triggered by", row.triggeredBy],
    ["queued", time(row.createdAt)],
    ["worker", workerText(row.workerId, row.leaseGeneration)],
    ["version", row.fredVersion ? <span className="font-mono">v{row.fredVersion}</span> : "·"],
    ...snapshotFacts({ phase: detail.phase, stageModels: row.stageModels, failure: detail.failure }),
  ];
  if (row.reason && row.status !== "done") entries.push(["reason", row.reason]);
  entries.push(
    ["publication", detail.publication.total === null ? "no saved result" : `${detail.publication.acknowledged} of ${detail.publication.total} effects acknowledged`],
    ["usage", usageText({ incomplete: row.usageIncomplete, confirmedStages: detail.usageConfirmedStages, reason: detail.usageIncompleteReason })],
  );
  return <Facts entries={entries} />;
}

function UsageTable({ usage }: { usage: NonNullable<ReviewData>["usage"] }) {
  if (usage.length === 0) return <div><SectionLabel>usage</SectionLabel><Empty className="px-0 py-1">No usage recorded.</Empty></div>;
  return (
    <div>
      <SectionLabel>usage</SectionLabel>
      <Table>
        <TableHeader><TableRow><TableHead>stage</TableHead><TableHead>model</TableHead><TableHead className="text-right">input</TableHead><TableHead className="text-right">cached</TableHead><TableHead className="text-right">output</TableHead><TableHead className="text-right">cost</TableHead></TableRow></TableHeader>
        <TableBody>
          {usage.map((row, index) => (
            <TableRow key={index}>
              <TableCell>{row.stage}{row.incomplete ? <span className="ml-2 text-warning">gap</span> : null}</TableCell>
              <TableCell><span title={row.model}><ModelMark model={row.model} /></span></TableCell>
              <TableCell className="text-right tabular-nums text-faint">{compact(row.inputTokens)}</TableCell>
              <TableCell className="text-right tabular-nums text-faint">{compact(row.cachedInputTokens)}</TableCell>
              <TableCell className="text-right tabular-nums text-faint">{compact(row.outputTokens)}</TableCell>
              <TableCell className="text-right tabular-nums">{usd(row.costUsd)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// Every stored finding, validator rejects included, so a review's judgment can be inspected without opening GitLab.
function FindingsList({ findings }: { findings: NonNullable<ReviewData>["findings"] }) {
  if (findings.length === 0) return <div><SectionLabel>findings</SectionLabel><Empty className="px-0 py-1">No findings stored.</Empty></div>;
  return (
    <div>
      <SectionLabel>findings · {findings.length}</SectionLabel>
      <ul className="divide-y">
        {findings.map((finding) => (
          <li key={finding._id} className="py-2">
            <div className="flex flex-wrap items-baseline gap-x-3">
              <span className={cn("font-medium", finding.status === "rejected" || finding.status === "duplicate" ? "text-faint line-through" : undefined)}>{finding.title}</span>
              <span className={finding.severity === "blocking" ? "text-bordeaux" : "text-faint"}>{severityLabel[finding.severity]}</span>
              <span className="text-faint">{finding.status}{finding.disposition && finding.disposition !== "open" ? ` · ${finding.disposition}` : ""}</span>
              <span className="font-mono text-faint">{finding.file}{finding.line !== null ? `:${finding.line}` : finding.oldLine !== null ? ` (old :${finding.oldLine})` : ""}</span>
            </div>
            <pre className="mt-1 whitespace-pre-wrap font-sans text-muted-foreground">{finding.body}</pre>
            {finding.rejectReason ? <p className="mt-1 text-faint">rejected: {finding.rejectReason}</p> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

const outcomeLabel = { completed: "completed", failed: "failed", timed_out: "timed out", interrupted: "interrupted" } as const satisfies Record<Transcript["outcome"], string>;

// One line per stage attempt of a collecting job, with its download. The empty states read as the run-locally guide's table.
function TranscriptList({ collecting, transcripts }: { collecting: boolean; transcripts: Transcript[] }) {
  if (!collecting) return <div><SectionLabel>transcripts</SectionLabel><Empty className="px-0 py-1">Collection off. The job was queued while the project's switch was off.</Empty></div>;
  if (transcripts.length === 0) return <div><SectionLabel>transcripts</SectionLabel><Empty className="px-0 py-1">None recorded. No stage reached the model, or the store failed; see the worker journal.</Empty></div>;
  // Lease generations start at 1, so a column of ones says nothing. It appears once a retry or recovery is among the rows.
  const showGeneration = transcripts.some((transcript) => transcript.leaseGeneration > 1);
  return (
    <div>
      <SectionLabel>transcripts · {transcripts.length}</SectionLabel>
      <Table>
        <TableHeader><TableRow><TableHead>stage</TableHead>{showGeneration ? <TableHead className="text-right">lease gen</TableHead> : null}<TableHead>outcome</TableHead><TableHead>model</TableHead><TableHead className="text-right">turns</TableHead><TableHead className="text-right">tool calls</TableHead><TableHead className="text-right">duration</TableHead><TableHead className="text-right">size</TableHead><TableHead className="text-right">file</TableHead></TableRow></TableHeader>
        <TableBody>
          {transcripts.map((transcript) => (
            <TableRow key={transcript._id}>
              <TableCell>{transcript.stage}</TableCell>
              {showGeneration ? <TableCell className="text-right tabular-nums text-faint">{transcript.leaseGeneration}</TableCell> : null}
              <TableCell>{transcript.outcome === "completed" ? outcomeLabel.completed : <Status tone="bad">{outcomeLabel[transcript.outcome]}</Status>}</TableCell>
              <TableCell><span className="inline-flex items-center gap-2 whitespace-nowrap" title={`${transcript.model} · ${transcript.effort}`}><ModelMark model={transcript.model} /><span className="text-faint">{transcript.effort}</span></span></TableCell>
              <TableCell className="text-right tabular-nums text-faint">{transcript.turns}</TableCell>
              <TableCell className="text-right tabular-nums text-faint">{transcript.toolCalls}</TableCell>
              <TableCell className="text-right tabular-nums text-faint">{duration(transcript.durationMs)}</TableCell>
              <TableCell className="text-right tabular-nums">{transcript.available ? fileSize(transcript.bytes) : "·"}</TableCell>
              <TableCell className="text-right"><TranscriptFile transcript={transcript} /></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// The download for a stored transcript, or why there is none.
function TranscriptFile({ transcript }: { transcript: Transcript }) {
  const { download, pending, error } = useTranscriptDownload(transcript._id);
  if (transcript.omitted === "too_large") return <span className="text-faint" title="The gzipped transcript exceeded 8 MiB. The row keeps its metadata without a file.">Too large</span>;
  if (!transcript.available) return <span className="text-faint">·</span>;
  return (
    <span className="inline-flex items-center justify-end gap-2 whitespace-nowrap">
      {error ? <span className="text-bordeaux" role="alert">{error}</span> : null}
      <Button variant="outline" size="sm" disabled={pending} onClick={() => void download()} aria-label={`Download ${transcript.stage} transcript, lease generation ${transcript.leaseGeneration}`}>
        {pending ? "Downloading" : "Download"}
      </Button>
    </span>
  );
}

// Fetches one transcript through admin.downloadTranscript and saves it under the controller's file name. The bytes come
// through the action because storage URLs carry no credential.
function useTranscriptDownload(transcriptId: Transcript["_id"]) {
  const fetchTranscript = useAction(api.admin.downloadTranscript);
  const call = useAdminCall();
  const download = () => call.run(async (adminSecret) => {
    const { fileName, bytes } = await fetchTranscript({ adminSecret, transcriptId });
    saveFile(new Blob([bytes], { type: "application/gzip" }), fileName);
    return "";
  }, "Download failed. Try again.");
  return { download, pending: call.busy, error: call.error };
}
