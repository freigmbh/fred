import { useEffect, useState } from "react";
import { Box, Page, PageLoading, PageTitle, Section, Tile, Tiles } from "@/components/group";
import { Progress, ProgressLabel } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Empty, MrLink, OwnerName, ProviderMark, Status } from "@/components/marks";
import { useAdminQuery } from "@/lib/admin";
import { api, type Queue as QueueData } from "@/lib/api";
import { findingsText, shortSha, workerText } from "@/lib/display";
import { duration, usd } from "@/lib/format";

type Row = QueueData["rows"][number];

const tickMs = 5000;
const stalledAfterMs = 5 * 60 * 1000;

// Server time advanced by locally measured elapsed time, so ages tick between updates without trusting the browser clock.
// Elapsed is keyed to the server time it was measured against, so a fresh result never inherits the previous result's age.
function useNow(serverNow: number) {
  const [clock, setClock] = useState({ serverNow, elapsed: 0 });
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => setClock({ serverNow, elapsed: Date.now() - started }), tickMs);
    return () => clearInterval(timer);
  }, [serverNow]);
  return serverNow + (clock.serverNow === serverNow ? clock.elapsed : 0);
}

export function Queue() {
  const queue = useAdminQuery(api.admin.queue, {});
  const now = useNow(queue?.now ?? 0);
  if (!queue) return <PageLoading />;
  const byStatus = (status: Row["status"]) => queue.rows.filter((row) => row.status === status);
  const [queued, running, publishing] = [byStatus("queued"), byStatus("running"), byStatus("publishing")];
  const workers = new Set([...running, ...publishing].map((row) => row.workerId)).size;
  const shared = { now, gitlabUrl: queue.gitlabUrl };
  return (
    <Page>
      <PageTitle title="Queue" fact={queue.rows.length === 0 ? "Nothing in flight" : `${queue.rows.length} ${queue.rows.length === 1 ? "job" : "jobs"} in flight`} />
      <Box>
        <Tiles columns={5}>
          <Tile label="queued" value={queued.length} />
          <Tile label="running" value={running.length} />
          <Tile label="publishing" value={publishing.length} />
          <Tile label="oldest queued" value={queued[0] ? duration(now - queued[0].createdAt) : "·"} />
          <Tile label="workers" value={workers} />
        </Tiles>
      </Box>
      <Section title={`Queued · ${queued.length}`}><QueuedTable rows={queued} {...shared} /></Section>
      <Section title={`Running · ${running.length}`}><RunningTable rows={running} {...shared} /></Section>
      <Section title={`Publishing · ${publishing.length}`}><PublishingTable rows={publishing} {...shared} /></Section>
    </Page>
  );
}

type StageProps = { rows: Row[]; now: number; gitlabUrl: string | null };

function Worker({ row }: { row: Row }) {
  return <span className="text-faint">{workerText(row.workerId, row.leaseGeneration)}</span>;
}

// A running job past its lease is failed as stale by the expiry sweep; a publishing job is re-claimed and recovered.
// Silence only counts while running, since lastActivityAt tracks model-stage activity and publication acks do not advance it.
// Before the first activity event the claim time stands in, so a job stuck loading context is not exempt.
function LeaseWarning({ row, now }: { row: Row; now: number }) {
  const overdue = row.leaseExpiresAt !== null && row.leaseExpiresAt <= now;
  const lastSeen = row.lastActivityAt ?? row.claimedAt;
  const silent = row.status === "running" && lastSeen !== null && now - lastSeen > stalledAfterMs;
  if (!overdue && !silent) return null;
  return <Status tone="warn">{overdue ? `lease past due ${duration(now - (row.leaseExpiresAt ?? now))}` : "no activity"}</Status>;
}

function QueuedTable({ rows, now, gitlabUrl }: StageProps) {
  if (rows.length === 0) return <Empty>Nothing queued.</Empty>;
  return (
    <Table>
      <TableHeader><TableRow><TableHead>Waiting</TableHead><TableHead>Bot</TableHead><TableHead>MR</TableHead><TableHead>SHA</TableHead><TableHead>Owner</TableHead></TableRow></TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.jobId}>
            <TableCell className="tabular-nums">{duration(now - row.createdAt)}</TableCell>
            <TableCell><ProviderMark provider={row.provider} /></TableCell>
            <TableCell><MrLink project={row.project} mrIid={row.mrIid} gitlabUrl={gitlabUrl} /></TableCell>
            <TableCell className="font-mono text-xs">{shortSha(row.headSha)}</TableCell>
            <TableCell><OwnerName developer={row.developer} /></TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function RunningTable({ rows, now, gitlabUrl }: StageProps) {
  if (rows.length === 0) return <Empty>Nothing running.</Empty>;
  return (
    <Table>
      <TableHeader><TableRow><TableHead>Running</TableHead><TableHead>Bot</TableHead><TableHead>MR</TableHead><TableHead>Phase</TableHead><TableHead>Last activity</TableHead><TableHead>Model</TableHead><TableHead>Owner</TableHead><TableHead>Worker</TableHead><TableHead className="text-right">Spent</TableHead><TableHead /></TableRow></TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.jobId}>
            <TableCell className="tabular-nums">{duration(now - (row.claimedAt ?? row.createdAt))}</TableCell>
            <TableCell><ProviderMark provider={row.provider} /></TableCell>
            <TableCell><MrLink project={row.project} mrIid={row.mrIid} gitlabUrl={gitlabUrl} />{row.previousReviewedSha ? <span className="ml-2 text-xs text-faint">re-review of {shortSha(row.previousReviewedSha)}</span> : null}</TableCell>
            <TableCell>{row.phase ?? <span className="text-faint">claimed</span>}</TableCell>
            <TableCell className="tabular-nums">{row.lastActivityAt === null ? "·" : `${duration(now - row.lastActivityAt)} ago`}</TableCell>
            <TableCell className="text-faint">{row.model ?? "·"}</TableCell>
            <TableCell><OwnerName developer={row.developer} /></TableCell>
            <TableCell><Worker row={row} /></TableCell>
            <TableCell className="text-right tabular-nums">{usd(row.costUsd)}</TableCell>
            <TableCell className="text-xs"><LeaseWarning row={row} now={now} /></TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// Acknowledged publication effects as "3 of 5" beside a bar of fixed width, or "·" before the result is saved.
function Effects({ publication }: { publication: Row["publication"] }) {
  const { total, acknowledged } = publication;
  if (total === null) return <span className="text-faint">·</span>;
  const label = `${acknowledged} of ${total}`;
  return (
    <Progress value={total === 0 ? 100 : Math.round((acknowledged / total) * 100)} getAriaValueText={() => label} className="w-32 flex-nowrap items-center gap-2">
      <ProgressLabel className="shrink-0 font-normal tabular-nums">{label}</ProgressLabel>
    </Progress>
  );
}

function PublishingTable({ rows, now, gitlabUrl }: StageProps) {
  if (rows.length === 0) return <Empty>Nothing publishing.</Empty>;
  return (
    <Table>
      <TableHeader><TableRow><TableHead>Publishing</TableHead><TableHead>Bot</TableHead><TableHead>MR</TableHead><TableHead>Effects</TableHead><TableHead>Findings</TableHead><TableHead>Owner</TableHead><TableHead>Worker</TableHead><TableHead className="text-right">Spent</TableHead><TableHead /></TableRow></TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.jobId}>
            <TableCell className="tabular-nums">{duration(now - (row.claimedAt ?? row.createdAt))}</TableCell>
            <TableCell><ProviderMark provider={row.provider} /></TableCell>
            <TableCell><MrLink project={row.project} mrIid={row.mrIid} gitlabUrl={gitlabUrl} /></TableCell>
            <TableCell><Effects publication={row.publication} /></TableCell>
            <TableCell>{row.findings ? findingsText(row.findings) || "none" : "·"}</TableCell>
            <TableCell><OwnerName developer={row.developer} /></TableCell>
            <TableCell><Worker row={row} /></TableCell>
            <TableCell className="text-right tabular-nums">{usd(row.costUsd)}</TableCell>
            <TableCell className="text-xs">
              <span className="inline-flex items-center gap-3">
                {row.leaseGeneration > 1 ? <Status tone="warn">recovered, lease gen {row.leaseGeneration}</Status> : null}
                <LeaseWarning row={row} now={now} />
              </span>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
