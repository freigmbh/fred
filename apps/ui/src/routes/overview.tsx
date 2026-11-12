import { useState } from "react";
import { ExpandableRow, useOneOpenRow } from "@/components/expandable-row";
import { Box, BoxHeading, MoreRow, Page, PageLoading, PageTitle, Section, Tile, Tiles } from "@/components/group";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Empty, Facts, Loading, MrLink, OwnerName, ProviderMark, snapshotFacts, Status, type FactEntry } from "@/components/marks";
import { useAdminQuery } from "@/lib/admin";
import { api, type FailureKind, type Failures, type Overview as OverviewData } from "@/lib/api";
import { failureKindLabel, failureKinds, failureKindTone, mrLabel, severities, severityLabel, shortSha, usageText, workerText } from "@/lib/display";
import { duration, monthName, percent, time, usd } from "@/lib/format";
import { useWindowStart } from "@/lib/time";

type Kind = "all" | FailureKind;
const kinds = ["all", ...failureKinds] as const satisfies readonly Kind[];
const kindLabel: Record<Kind, string> = { all: "All", ...failureKindLabel };

export function Overview() {
  const overview = useAdminQuery(api.admin.overview, {});
  if (!overview) return <PageLoading />;
  const bots = activeBots(overview.outcomes);
  const done = bots.reduce((sum, row) => sum + row.done, 0);
  return (
    <Page>
      <PageTitle title="Overview" fact={`${done} ${done === 1 ? "review" : "reviews"} completed in ${monthName(overview.month)}`}>
        <Flags flags={overview.flags} />
      </PageTitle>
      <Box><HealthStrip overview={overview} /></Box>
      <div className="grid gap-x-4 lg:grid-cols-2">
        <Section title={`Outcomes · ${monthName(overview.month)}`}><OutcomesTable outcomes={bots} /></Section>
        <Section title="Latency"><LatencyTable outcomes={bots} /></Section>
      </div>
      <FailuresSection />
    </Page>
  );
}

// The two policy switches as status words. Both live in the Convex dashboard; here they only read.
function Flags({ flags }: { flags: OverviewData["flags"] }) {
  return (
    <div className="flex items-center gap-4 text-xs">
      {flags.globalEnabled ? <Status tone="ok">Reviews enabled</Status> : <Status tone="bad">Reviews disabled</Status>}
      {flags.maintenanceMode ? <Status tone="bad">Maintenance on</Status> : <Status tone="off">Maintenance off</Status>}
    </div>
  );
}

function HealthStrip({ overview }: { overview: OverviewData }) {
  const { queue, last7Days } = overview;
  const enqueueDenials = Object.entries(last7Days.deniedAtEnqueue).filter(([, count]) => count > 0);
  return (
    <Tiles columns={8}>
      <Tile label="queued" value={queue.queued} />
      <Tile label="running" value={queue.running} />
      <Tile label="publishing" value={queue.publishing} />
      <Tile label="oldest queued" value={queue.oldestQueuedAt === null ? "·" : duration(overview.now - queue.oldestQueuedAt)} />
      <Tile label="failed 7d" value={last7Days.failed} tone={last7Days.failed ? "bad" : undefined} />
      <Tile label="denied 7d" value={last7Days.denied} />
      <Tile label="note failed 7d" value={last7Days.noteFailed} />
      <Tile
        label="denied at enqueue 7d"
        value={enqueueDenials.reduce((sum, [, count]) => sum + count, 0)}
        sub={enqueueDenials.length ? enqueueDenials.map(([gate, count]) => `${gate.replace("_", " ")} ${count}`).join(" · ") : undefined}
      />
    </Tiles>
  );
}

// FRED always, and the retired Claude and Codex bots only in months they still completed reviews.
function activeBots(outcomes: OverviewData["outcomes"]) {
  return outcomes.filter((row) => row.provider === "fred" || row.done > 0);
}

function OutcomesTable({ outcomes }: { outcomes: OverviewData["outcomes"] }) {
  if (outcomes.every((row) => row.done === 0)) return <Empty>No completed reviews this month.</Empty>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Bot</TableHead><TableHead className="text-right">Done</TableHead><TableHead className="text-right">Clean</TableHead>
          {severities.map((severity) => <TableHead key={severity} className="text-right first-letter:uppercase">{severityLabel[severity]}</TableHead>)}
          <TableHead className="text-right">Validator reject</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {outcomes.map((row) => (
          <TableRow key={row.provider}>
            <TableCell><ProviderMark provider={row.provider} /></TableCell>
            <TableCell className="text-right tabular-nums">{row.done}</TableCell>
            <TableCell className="text-right tabular-nums">{percent(row.clean, row.done)}</TableCell>
            {severities.map((severity) => <TableCell key={severity} className="text-right tabular-nums">{row.findings[severity]}</TableCell>)}
            <TableCell className="text-right tabular-nums">{percent(row.validatorRejected, row.findingsTotal)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function LatencyTable({ outcomes }: { outcomes: OverviewData["outcomes"] }) {
  if (outcomes.every((row) => row.latency.claimP50Ms === null)) return <Empty>No completed reviews this month.</Empty>;
  return (
    <Table>
      <TableHeader><TableRow><TableHead>Bot</TableHead><TableHead className="text-right">Claim p50</TableHead><TableHead className="text-right">Claim max</TableHead><TableHead className="text-right">Run p50</TableHead><TableHead className="text-right">Run max</TableHead></TableRow></TableHeader>
      <TableBody>
        {outcomes.map((row) => (
          <TableRow key={row.provider}>
            <TableCell><ProviderMark provider={row.provider} /></TableCell>
            <TableCell className="text-right tabular-nums">{duration(row.latency.claimP50Ms)}</TableCell>
            <TableCell className="text-right tabular-nums">{duration(row.latency.claimMaxMs)}</TableCell>
            <TableCell className="text-right tabular-nums">{duration(row.latency.runP50Ms)}</TableCell>
            <TableCell className="text-right tabular-nums">{duration(row.latency.runMaxMs)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function FailuresSection() {
  const [kind, setKind] = useState<Kind>("all");
  const [older, setOlder] = useState(false);
  const since = useWindowStart(older ? null : 30);
  const failures = useAdminQuery(api.admin.failures, {
    limit: older ? 100 : 50,
    ...(since === null ? {} : { since }),
    ...(kind === "all" ? {} : { kind }),
  });
  return (
    <section className="mt-5">
      <BoxHeading title={`Failures · ${older ? "newest 100" : "last 30 days"}`}>
        <Tabs value={kind} onValueChange={(value) => setKind(value as Kind)}>
          <TabsList aria-label="Kind">{kinds.map((value) => <TabsTrigger key={value} value={value}>{kindLabel[value]}</TabsTrigger>)}</TabsList>
        </Tabs>
      </BoxHeading>
      <Box>
        {failures ? <FailuresTable failures={failures} /> : <Loading />}
        {failures && !older ? <MoreRow onClick={() => setOlder(true)}>Show older</MoreRow> : null}
        {failures && older && failures.hasMore ? <MoreRow>Older rows exist beyond the newest 100.</MoreRow> : null}
      </Box>
    </section>
  );
}

function FailuresTable({ failures }: { failures: Failures }) {
  const rowToggle = useOneOpenRow<Failures["rows"][number]["_id"]>();
  if (failures.rows.length === 0) return <Empty>No failures in this window.</Empty>;
  return (
    <Table>
      <TableHeader>
        <TableRow><TableHead>When</TableHead><TableHead>Kind</TableHead><TableHead>Reason</TableHead><TableHead>Bot</TableHead><TableHead>MR</TableHead><TableHead>Triggered</TableHead><TableHead>Owner</TableHead><TableHead className="text-right">Spent</TableHead><TableHead>Code</TableHead><TableHead /></TableRow>
      </TableHeader>
      <TableBody>
        {failures.rows.map((row) => (
          <ExpandableRow key={row._id} {...rowToggle(row._id)} label={`Failure details for ${mrLabel(row.project, row.mrIid)}, ${time(row.at)}`} detail={<FailureDetail row={row} />}>
            <TableCell className="tabular-nums">{time(row.at)}</TableCell>
            <TableCell><Status tone={failureKindTone[row.kind]}>{failureKindLabel[row.kind].toLowerCase()}</Status></TableCell>
            <TableCell className="max-w-72 truncate" title={row.reason}>{row.reason}</TableCell>
            <TableCell><ProviderMark provider={row.provider} /></TableCell>
            <TableCell><MrLink project={row.project} mrIid={row.mrIid} gitlabUrl={failures.gitlabUrl} /></TableCell>
            <TableCell>{row.triggeredBy ?? "·"}</TableCell>
            <TableCell><OwnerName developer={row.developer} /></TableCell>
            <TableCell className="text-right tabular-nums">{usd(row.costUsd)}</TableCell>
            <TableCell className="text-faint">{row.providerCode ?? row.failureCategory ?? "·"}</TableCell>
          </ExpandableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function FailureDetail({ row }: { row: Failures["rows"][number] }) {
  const { detail } = row;
  const entries: FactEntry[] = [["summary", row.summary]];
  if (detail) {
    entries.push(
      ["model", detail.model ?? "·"], ["effort", detail.effort ?? "·"],
      ...snapshotFacts(detail),
      ["worker", workerText(detail.workerId, detail.leaseGeneration)],
      ["usage", usageText({ incomplete: detail.usageIncomplete, confirmedStages: detail.usageConfirmedStages })],
      ["comment", detail.noteStatus ?? "·"],
      ["job now", `${detail.status} · ${shortSha(detail.headSha)}`],
    );
  }
  return <Facts entries={entries} />;
}
