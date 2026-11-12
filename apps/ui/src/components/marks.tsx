import { cn } from "cn";
import { ChevronDownIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { AdminCall } from "@/lib/admin";
import { providerLabel, type Provider, type Review, type StageModels } from "@/lib/api";
import { failureLine, mrLabel, selectionText, type Tone } from "@/lib/display";
import { labInfo, modelLab, modelName } from "@/lib/labs";

const dot = "mr-1.5 inline-block size-2 shrink-0 rounded-full align-middle";
const toneDot: Record<Tone, string> = { ok: "bg-brand", warn: "bg-warning", bad: "bg-bordeaux", off: "bg-faint" };
const toneText: Record<Tone, string> = { ok: "", warn: "text-warning", bad: "text-bordeaux", off: "font-normal text-faint" };
const providerDot: Record<Provider, string> = { fred: "bg-brand", claude: "bg-claude", codex: "bg-codex" };

// A small tone mark next to its word. Never color alone.
export function Dot({ tone, className }: { tone: Tone; className?: string }) {
  return <i className={cn(dot, toneDot[tone], className)} aria-hidden />;
}

// A status word with its dot, both in the tone: "done", "failed", "Works".
export function Status({ tone, children, className }: { tone: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 font-medium whitespace-nowrap", toneText[tone], className)}>
      <Dot tone={tone} className="mr-0" />{children}
    </span>
  );
}

export function ProviderMark({ provider }: { provider: Provider }) {
  return <span className="whitespace-nowrap"><i className={cn(dot, providerDot[provider])} aria-hidden />{providerLabel[provider]}</span>;
}

// A lab's logo in its brand color. Labs without a known logo get a lettermark.
export function LabIcon({ lab, className }: { lab: string; className?: string }) {
  const { label, color, path } = labInfo(lab);
  if (path === null) {
    return <i className={cn("inline-flex size-3 shrink-0 items-center justify-center rounded-xs text-[8px] font-bold not-italic leading-none text-white", className)} style={{ background: color }} aria-hidden>{label.slice(0, 1).toUpperCase()}</i>;
  }
  return <svg viewBox="0 0 24 24" className={cn("size-3 shrink-0", className)} fill={color} aria-hidden><path d={path} /></svg>;
}

export function LabMark({ lab, className }: { lab: string; className?: string }) {
  return <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap align-middle", className)}><LabIcon lab={lab} />{labInfo(lab).label}</span>;
}

// The lab icon of a model ID, or nothing for a legacy ID without a lab.
export function ModelLabIcon({ model }: { model: string }) {
  const lab = modelLab(model);
  return lab ? <LabIcon lab={lab} /> : null;
}

// A model as a secondary Badge: its lab's icon and the slug without the lab prefix. The full ID is in the tooltip.
export function ModelChip({ model, title }: { model: string; title?: string }) {
  return <Badge variant="secondary" title={title ?? model}><ModelLabIcon model={model} />{modelName(model)}</Badge>;
}

// A model inline, without a chip: lab icon and short name. For dense tables inside details.
export function ModelMark({ model }: { model: string }) {
  return <span className="inline-flex items-center gap-1.5 whitespace-nowrap"><ModelLabIcon model={model} />{modelName(model)}</span>;
}

// A label inside an expanded detail block, above its list or table.
export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("mb-1.5 text-xs font-semibold text-muted-foreground", className)}>{children}</div>;
}

// The faint line a Box or detail block shows instead of an empty list or table.
export function Empty({ children, className }: { children: ReactNode; className?: string | undefined }) {
  return <p className={cn("px-3 py-3 text-faint", className)}>{children}</p>;
}

// The faint line a Box or detail block shows while its query loads.
export function Loading({ className }: { className?: string }) {
  return <Empty className={className}>Loading.</Empty>;
}

// A link to the MR on GitLab, or plain text when the base URL or project is unknown. Clicks stay on the link, so a link inside an expandable row does not toggle it.
export function MrLink({ project, mrIid, gitlabUrl }: { project: { path: string } | null; mrIid: number; gitlabUrl: string | null }) {
  const label = mrLabel(project, mrIid);
  if (!gitlabUrl || !project) return <span>{label}</span>;
  return <a href={`${gitlabUrl}/${project.path}/-/merge_requests/${mrIid}`} target="_blank" rel="noopener noreferrer" className="text-brand underline underline-offset-2" onClick={(event) => event.stopPropagation()}>{label}</a>;
}

// The budget owner as the reference describes it: GitLab full name, then username, then the numeric GitLab user ID ("?" when
// even that is unknown, as on a spend row whose developer record is gone).
export function OwnerName({ developer }: { developer: { gitlabUserId: string | null; username: string | null; displayName: string | null } | null }) {
  if (!developer) return "·";
  return developer.displayName ?? developer.username ?? <span className="text-faint">id {developer.gitlabUserId ?? "?"}</span>;
}

export function FailureText({ text }: { text: string }) {
  return <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">{text}</pre>;
}

export type FactEntry = [label: string, value: ReactNode];

// A list of label and value pairs inside a detail block.
export function Facts({ entries }: { entries: FactEntry[] }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-5 gap-y-1 text-xs">
      {entries.map(([label, value]) => <div key={label} className="contents"><dt className="text-faint">{label}</dt><dd className="min-w-0 break-words text-muted-foreground">{value}</dd></div>)}
    </dl>
  );
}

// The facts a failure row and a review row share: the phase the job reached, the stage selections fixed at enqueue, and the
// stored failure snapshot with its detail text, each when known.
export function snapshotFacts({ phase, stageModels, failure }: {
  phase: NonNullable<Review>["phase"]; stageModels: StageModels | null; failure: NonNullable<Review>["failure"];
}): FactEntry[] {
  const entries: FactEntry[] = [["phase", phase ?? "·"]];
  if (stageModels) entries.push(["detection", selectionText(stageModels.detect)], ["validation", selectionText(stageModels.validate)]);
  if (failure) entries.push(["failure", failureLine(failure)]);
  if (failure?.detail) entries.push(["detail", <FailureText text={failure.detail} />]);
  return entries;
}

// The button that opens or closes a table row's detail. It lives in its own cell so the MR link next to it stays a link.
export function ExpandButton({ open, label, onClick }: { open: boolean; label: string; onClick: () => void }) {
  return (
    <Button variant="ghost" size="icon-sm" aria-expanded={open} aria-label={label} onClick={(event) => { event.stopPropagation(); onClick(); }}>
      <ChevronDownIcon className={cn("transition-transform", open && "rotate-180")} />
    </Button>
  );
}

// An admin call's outcome: the failure in Bordeaux, otherwise the last success message. Renders nothing while idle.
export function CallStatus({ call }: { call: AdminCall }) {
  if (call.error) return <span className="text-bordeaux" role="alert">{call.error}</span>;
  return call.message ? <span className="text-faint" role="status">{call.message}</span> : null;
}
