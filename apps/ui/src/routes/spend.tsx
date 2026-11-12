import { useState, type ReactNode } from "react";
import { cn } from "cn";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { Area, CartesianGrid, ComposedChart, Line, ReferenceArea, ReferenceLine, XAxis, YAxis, type TooltipContentProps } from "recharts";
import { Box, Page, PageLoading, PageTitle, Section, Tile, Tiles } from "@/components/group";
import { Button } from "@/components/ui/button";
import { ChartContainer, ChartTooltip } from "@/components/ui/chart";
import { Item, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Empty, LabMark, ModelMark, OwnerName, Status } from "@/components/marks";
import { useAdminQuery } from "@/lib/admin";
import { api, type Spend as SpendData } from "@/lib/api";
import { compact, day, monthName, percent, shiftMonth, usd, usdWhole } from "@/lib/format";
import { labInfo } from "@/lib/labs";

type Monthly = SpendData["monthly"];
type Tokens = Monthly["byLab"][number]["tokens"];

const views = ["daily", "cumulative"] as const;
type View = (typeof views)[number];
const breakdowns = ["model", "owner"] as const;
type Breakdown = (typeof breakdowns)[number];
const breakdownLabel: Record<Breakdown, string> = { model: "Model", owner: "Budget owner" };

const tokenTotal = (tokens: Tokens) => tokens.inputTokens + tokens.cachedInputTokens + tokens.outputTokens;
const perReview = (costUsd: number, reviews: number) => (reviews === 0 ? "·" : usd(costUsd / reviews));
// Cached input over all input: how much of what the models read came from the prompt cache.
const cacheHit = (tokens: Tokens) => percent(tokens.cachedInputTokens, tokens.cachedInputTokens + tokens.inputTokens);
const isWeekend = (value: string) => [0, 6].includes(new Date(`${value}T00:00:00Z`).getUTCDay());
const monthReviews = (monthly: Monthly) => monthly.byLab.reduce((sum, row) => sum + row.reviews, 0);
const monthTokens = (monthly: Monthly): Tokens => monthly.byLab.reduce(
  (sum, row) => ({ inputTokens: sum.inputTokens + row.tokens.inputTokens, cachedInputTokens: sum.cachedInputTokens + row.tokens.cachedInputTokens, outputTokens: sum.outputTokens + row.tokens.outputTokens }),
  { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
);

// One month at a time, the way budgets run: the month's cost as the headline over its facts, the daily chart and token mix
// beside the labs that double as the chart's legend, then a ranked breakdown by model or budget owner.
export function Spend() {
  const [month, setMonth] = useState<string | null>(null);
  const spend = useAdminQuery(api.admin.spend, month ? { month } : {});
  if (!spend) return <PageLoading />;
  const { monthly } = spend;
  const currentMonth = spend.today.slice(0, 7);
  const current = spend.month === currentMonth;
  const tokens = monthTokens(monthly);
  return (
    <Page>
      <PageTitle title="Spend"><MonthNav month={spend.month} last={currentMonth} onChange={setMonth} /></PageTitle>
      <Box>
        <Headline monthly={monthly} current={current} />
        <MonthTiles monthly={monthly} tokens={tokens} />
      </Box>
      <div className="grid gap-x-4 lg:grid-cols-3">
        <div className="flex min-w-0 flex-col lg:col-span-2">
          <DailyChart monthly={monthly} today={spend.today} current={current} />
          <TokensByType tokens={tokens} />
        </div>
        <LabList monthly={monthly} />
      </div>
      <BreakdownSection monthly={monthly} />
    </Page>
  );
}

// Previous month, the month's name, next month. Next stops at `last`.
function MonthNav({ month, last, onChange }: { month: string; last: string; onChange: (month: string) => void }) {
  return (
    <div className="flex items-center gap-2">
      <Button variant="outline" size="icon" aria-label="Previous month" onClick={() => onChange(shiftMonth(month, -1))}><ChevronLeftIcon /></Button>
      <span className="min-w-32 text-center font-medium">{monthName(month)}</span>
      <Button variant="outline" size="icon" aria-label="Next month" disabled={month >= last} onClick={() => onChange(shiftMonth(month, 1))}><ChevronRightIcon /></Button>
    </div>
  );
}

// The top of the summary Box: the month's cost, and where the working-day burn lands at month end while the month runs.
function Headline({ monthly, current }: { monthly: Monthly; current: boolean }) {
  return (
    <div className="px-3 py-3">
      <div className="text-4xl leading-none font-semibold tracking-tight tabular-nums">{usd(monthly.costUsd)}</div>
      {current && monthly.projectedUsd !== null ? <p className="mt-2 text-faint">projected <span className="font-medium text-foreground tabular-nums">{usdWhole(monthly.projectedUsd)}</span> at month end</p> : null}
    </div>
  );
}

// The month's facts under the headline. Per working day carries the elapsed working days, which the projection runs on.
function MonthTiles({ monthly, tokens }: { monthly: Monthly; tokens: Tokens }) {
  const reviews = monthReviews(monthly);
  const { workingDays, perWorkingDayUsd } = monthly;
  return (
    <Tiles columns={4}>
      <Tile label="reviews" value={reviews} />
      <Tile label="per review" value={perReview(monthly.costUsd, reviews)} />
      <Tile label="tokens" value={compact(tokenTotal(tokens))} />
      <Tile label="per working day" value={perWorkingDayUsd === null ? "·" : usd(perWorkingDayUsd)} sub={`${workingDays.elapsed} of ${workingDays.total} working days`} />
    </Tiles>
  );
}

// The month's spend per lab, largest first: the lab, its reviews, and its cost, then share, cost per review, and tokens. The dots
// match the chart, so the list doubles as its legend. Every lab gets a row; the Box grows to fit them.
function LabList({ monthly }: { monthly: Monthly }) {
  return (
    <Section title="By lab" className="min-w-0">
      {monthly.byLab.length === 0 ? <Empty>No usage recorded this month.</Empty> : monthly.byLab.map((row) => (
        <Item key={row.lab} size="xs">
          <ItemContent className="min-w-0">
            <ItemTitle className="w-full">
              <i className="size-2 shrink-0 rounded-full" style={{ background: labInfo(row.lab).color }} aria-hidden /><LabMark lab={row.lab} />
              <span className="font-normal text-faint">{row.reviews} {row.reviews === 1 ? "review" : "reviews"}</span>
              <span className="ml-auto tabular-nums">{usd(row.costUsd)}</span>
            </ItemTitle>
            <ItemDescription>{percent(row.costUsd, monthly.costUsd)} · {perReview(row.costUsd, row.reviews)} per review · {compact(tokenTotal(row.tokens))} tokens</ItemDescription>
          </ItemContent>
        </Item>
      ))}
    </Section>
  );
}

// A chart row: the day, each lab's value, and in cumulative view the projection points that draw the dashed line to month end.
type ChartRow = { day: string; byLab: Record<string, number | undefined>; projected?: number };

// Daily cost per lab, or the month's running total per lab stacked with a dashed line from today to the working-day projection.
// Weekends are shaded, since the projection counts working days only, and today is marked in the current month. The chart
// grows past its minimum height so its column ends level with the lab list beside it.
function DailyChart({ monthly, today, current }: { monthly: Monthly; today: string; current: boolean }) {
  const [view, setView] = useState<View>("daily");
  const labs = monthly.byLab.map((row) => row.lab);
  // The running total shows the whole month, so the projection has somewhere to go; daily cost stops at today.
  const days = view === "cumulative" ? wholeMonth(monthly.days) : monthly.days;
  const rows = view === "daily" ? monthly.daily : cumulativeRows(monthly, days, current ? today : null);
  const weekends = days.filter((value, index) => isWeekend(value) && (index === 0 || !isWeekend(days[index - 1] ?? "")));
  const first = days[0];
  const middle = days[Math.floor(days.length / 2)];
  const last = days.at(-1);
  const tabs = (
    <Tabs value={view} onValueChange={(value) => setView(value as View)}>
      <TabsList aria-label="Chart view"><TabsTrigger value="daily">Daily</TabsTrigger><TabsTrigger value="cumulative">Cumulative</TabsTrigger></TabsList>
    </Tabs>
  );
  return (
    <Section title={view === "daily" ? "Daily cost" : "Running total"} heading={tabs} className="flex-1">
      {monthly.costUsd === 0 ? <Empty>No usage recorded this month.</Empty> : (
        <div className="flex flex-1 flex-col p-3">
          <ChartContainer config={Object.fromEntries(labs.map((lab) => [lab, labInfo(lab)]))} className="aspect-auto min-h-75 w-full flex-1">
            <ComposedChart data={rows} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--border)" />
              {weekends.map((start) => <ReferenceArea key={start} x1={start} x2={nextDay(days, start)} fill="var(--foreground)" fillOpacity={0.035} strokeOpacity={0} ifOverflow="hidden" />)}
              <XAxis dataKey="day" ticks={[first, middle, last].filter((value): value is string => value !== undefined)} tickFormatter={(value: string) => day(value).toUpperCase()} tickLine={false} axisLine={false} height={24} tickMargin={10} tick={{ fill: "var(--faint)", fontSize: 11 }} />
              <YAxis tickFormatter={(value: number) => usdWhole(value)} tickLine={false} axisLine={false} width={44} tick={{ fill: "var(--faint)", fontSize: 11 }} />
              <ChartTooltip cursor={{ stroke: "var(--border)" }} content={DailyTooltip} />
              {labs.map((lab) => (
                <Area key={lab} name={lab} dataKey={(row: ChartRow) => row.byLab[lab]} {...(view === "cumulative" ? { stackId: "total" } : {})} type="monotone" stroke={labInfo(lab).color} fill={labInfo(lab).color} fillOpacity={0.16} strokeWidth={2}
                  dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--background)" }} isAnimationActive={false} connectNulls={false} />
              ))}
              {view === "cumulative" ? <Line name="projected" dataKey="projected" type="linear" stroke="var(--faint)" strokeWidth={1.5} strokeDasharray="4 4" dot={false} activeDot={false} connectNulls isAnimationActive={false} legendType="none" /> : null}
              {current && days.includes(today) ? <ReferenceLine x={today} stroke="var(--faint)" strokeDasharray="2 3" /> : null}
            </ComposedChart>
          </ChartContainer>
        </div>
      )}
    </Section>
  );
}

// Every day of the month the given days belong to, so a month in progress still spans to its last day.
function wholeMonth(days: string[]) {
  const first = days[0];
  if (!first) return days;
  const [year, month] = first.split("-").map(Number);
  const count = new Date(Date.UTC(year ?? 0, month ?? 1, 0)).getUTCDate();
  return Array.from({ length: count }, (_, index) => `${first.slice(0, 8)}${String(index + 1).padStart(2, "0")}`);
}

// Running totals per lab up to `today` (every day when the month is over), plus the projection's two points: today's total
// and the working-day projection on the last day. Days after today carry no lab values, so the areas stop at today.
function cumulativeRows(monthly: Monthly, days: string[], today: string | null): ChartRow[] {
  const running: Record<string, number> = {};
  const byDay = new Map(monthly.daily.map((row) => [row.day, row.byLab]));
  const last = days.at(-1);
  return days.map((value) => {
    if (today !== null && value > today) return { day: value, byLab: {}, ...(value === last && monthly.projectedUsd !== null ? { projected: monthly.projectedUsd } : {}) };
    for (const [lab, cost] of Object.entries(byDay.get(value) ?? {})) running[lab] = (running[lab] ?? 0) + cost;
    const total = Object.values(running).reduce((sum, value) => sum + value, 0);
    return { day: value, byLab: { ...running }, ...(value === today ? { projected: total } : {}) };
  });
}

// The day after `value` in `days`, where a weekend's shading ends.
function nextDay(days: string[], value: string) {
  return days[days.indexOf(value) + 1] ?? value;
}

// The hovered day per lab, then the day's total under a rule. The projection line stays out of it.
function DailyTooltip({ active, payload, label }: TooltipContentProps) {
  const rows = payload?.filter((item) => item.name !== "projected" && item.value !== undefined) ?? [];
  if (!active || rows.length === 0) return null;
  const total = rows.reduce((sum, item) => sum + Number(item.value ?? 0), 0);
  return (
    <div className="grid min-w-48 gap-1 rounded-lg border bg-popover px-3 py-2 text-popover-foreground shadow-lg">
      <div className="text-faint">{day(String(label))}</div>
      {rows.map((item) => (
        <div key={String(item.name)} className="flex items-center justify-between gap-6">
          <LabMark lab={String(item.name)} />
          <span className="tabular-nums">{usd(Number(item.value ?? 0))}</span>
        </div>
      ))}
      <div className="mt-0.5 flex justify-between gap-6 border-t pt-1">
        <span className="text-faint">Total</span>
        <span className="font-medium tabular-nums">{usd(total)}</span>
      </div>
    </div>
  );
}

const tokenTypes = [
  { key: "cachedInputTokens", label: "Cached input", className: "bg-brand" },
  { key: "inputTokens", label: "Uncached input", className: "bg-foreground/45" },
  { key: "outputTokens", label: "Output", className: "bg-foreground/20" },
] as const satisfies readonly { key: keyof Tokens; label: string; className: string }[];

// The month's token mix as one stacked bar with its legend and cache hit under it. Cached input leads in green because it is
// the cheap part; segments under 1% keep a sliver so they stay findable.
function TokensByType({ tokens }: { tokens: Tokens }) {
  const total = tokenTotal(tokens);
  return (
    <Section title="Tokens by type">
      {total === 0 ? <Empty>No tokens this month.</Empty> : (
        <div className="px-3 py-3">
          <div className="flex h-2 w-full gap-0.5 overflow-hidden rounded-full" aria-hidden>
            {tokenTypes.map((type) => tokens[type.key] > 0 ? <i key={type.key} className={cn("block rounded-full", type.className)} style={{ width: `${Math.max(0.5, (tokens[type.key] / total) * 100)}%` }} /> : null)}
          </div>
          <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5">
            {tokenTypes.map((type) => (
              <li key={type.key} className="inline-flex items-center gap-2 text-faint">
                <i className={cn("size-2 rounded-xs", type.className)} aria-hidden />{type.label}<span className="font-medium text-foreground tabular-nums">{compact(tokens[type.key])}</span>
              </li>
            ))}
            <li className="text-faint">Cache hit <span className="font-medium text-foreground tabular-nums">{cacheHit(tokens)}</span></li>
          </ul>
        </div>
      )}
    </Section>
  );
}

// The month's cost by model or budget owner: one ranked table at a time. Model rows draw their share of the month under the
// name; owner rows draw how much of their own budget is used, in amber past 80% and Bordeaux once spent.
function BreakdownSection({ monthly }: { monthly: Monthly }) {
  const [breakdown, setBreakdown] = useState<Breakdown>("model");
  const tabs = (
    <Tabs value={breakdown} onValueChange={(value) => setBreakdown(value as Breakdown)}>
      <TabsList aria-label="Breakdown">{breakdowns.map((value) => <TabsTrigger key={value} value={value}>{breakdownLabel[value]}</TabsTrigger>)}</TabsList>
    </Tabs>
  );
  return (
    <Section title="Breakdown" heading={tabs}>
      {breakdown === "model" ? <ModelTable rows={monthly.byModel} total={monthly.costUsd} /> : <OwnerTable rows={monthly.byDeveloper} />}
    </Section>
  );
}

function Rank({ index }: { index: number }) {
  return <TableCell className="w-8 pr-0 tabular-nums text-faint">{index + 1}</TableCell>;
}

// A name with a bar underneath, `fraction` from 0 to 1 of the row's width.
function Ranked({ fraction, color, children }: { fraction: number; color: string; children: ReactNode }) {
  return (
    <span className="block min-w-0">
      <span className="block">{children}</span>
      <i className="mt-1.5 block h-0.5 min-w-1.5 rounded-full" style={{ width: `${Math.max(0, Math.min(1, fraction)) * 100}%`, background: color }} aria-hidden />
    </span>
  );
}

// Models ranked by cost, each bar its share of the month in its lab's color.
function ModelTable({ rows, total }: { rows: Monthly["byModel"]; total: number }) {
  if (rows.length === 0) return <Empty>No usage recorded this month.</Empty>;
  return (
    <Table>
      <TableHeader><TableRow><TableHead>#</TableHead><TableHead className="w-1/3">Model</TableHead><TableHead className="text-right">Cost</TableHead><TableHead className="text-right">Share</TableHead><TableHead className="text-right">Cache hit</TableHead><TableHead className="text-right">Tokens</TableHead></TableRow></TableHeader>
      <TableBody>
        {rows.map((row, index) => (
          <TableRow key={row.model}>
            <Rank index={index} />
            <TableCell><Ranked fraction={total ? row.costUsd / total : 0} color={labInfo(row.lab).color}><span title={row.model} className="font-medium"><ModelMark model={row.model} /></span></Ranked></TableCell>
            <TableCell className="text-right tabular-nums">{usd(row.costUsd)}</TableCell>
            <TableCell className="text-right tabular-nums text-faint">{percent(row.costUsd, total)}</TableCell>
            <TableCell className="text-right tabular-nums text-faint">{cacheHit(row.tokens)}</TableCell>
            <TableCell className="text-right tabular-nums text-faint">{compact(tokenTotal(row.tokens))}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function budgetColor(used: number) {
  return used >= 1 ? "var(--bordeaux)" : used >= 0.8 ? "var(--warning)" : "var(--brand)";
}

// Budget owners ranked by spend, each bar the used part of their own budget, with exhausted, blocked, and incomplete-usage marks.
function OwnerTable({ rows }: { rows: Monthly["byDeveloper"] }) {
  if (rows.length === 0) return <Empty>No usage recorded this month.</Empty>;
  return (
    <Table>
      <TableHeader><TableRow><TableHead>#</TableHead><TableHead className="w-1/3">Budget owner</TableHead><TableHead className="text-right">Spent</TableHead><TableHead className="text-right">Budget</TableHead><TableHead className="text-right">Used</TableHead><TableHead className="text-right">Remaining</TableHead><TableHead className="text-right">Reviews</TableHead><TableHead /></TableRow></TableHeader>
      <TableBody>
        {rows.map((row, index) => {
          const used = row.budgetUsd > 0 ? row.costUsd / row.budgetUsd : 1;
          const remaining = row.budgetUsd - row.costUsd;
          return (
            <TableRow key={row.developerId}>
              <Rank index={index} />
              <TableCell>
                <Ranked fraction={used} color={budgetColor(used)}>
                  <span className="block max-w-64 truncate font-medium" title={row.displayName ?? row.username ?? undefined}><OwnerName developer={row} /></span>
                </Ranked>
              </TableCell>
              <TableCell className="text-right tabular-nums">{usd(row.costUsd)}</TableCell>
              <TableCell className="text-right tabular-nums text-faint">{usdWhole(row.budgetUsd)}{row.budgetOverride ? " override" : ""}</TableCell>
              <TableCell className="text-right tabular-nums text-faint">{percent(row.costUsd, row.budgetUsd)}</TableCell>
              <TableCell className="text-right tabular-nums">{usd(Math.max(0, remaining))}</TableCell>
              <TableCell className="text-right tabular-nums text-faint">{row.reviews}</TableCell>
              <TableCell>
                <span className="inline-flex items-center gap-3">
                  {remaining <= 0 ? <Status tone="warn">exhausted</Status> : null}
                  {row.blocked ? <Status tone="bad">blocked</Status> : null}
                  {row.incompleteJobs ? <span className="text-faint">usage incomplete on {row.incompleteJobs} {row.incompleteJobs === 1 ? "job" : "jobs"}</span> : null}
                </span>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
