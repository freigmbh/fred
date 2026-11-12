import { cn } from "cn";
import { PlusIcon } from "lucide-react";
import { Fragment, useState, type ReactNode } from "react";
import { Page, PageLoading } from "@/components/group";
import { Dot } from "@/components/marks";
import { Button } from "@/components/ui/button";
import { Item, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from "@/components/ui/native-select";
import { useAdminQuery } from "@/lib/admin";
import { api } from "@/lib/api";
import { projectName, projectNamespace } from "@/lib/display";
import { projectGroups, tokenHealth, type ProjectRow } from "@/lib/projects";
import { NewProject, ProjectDetail } from "./project-detail";

// What the detail pane shows: the connect form for a new project, or one project by its GitLab path.
type Selection = { kind: "connect" } | { kind: "project"; path: string };
type Group = ReturnType<typeof projectGroups>[number];
const connectValue = "connect";

export function Projects() {
  const data = useAdminQuery(api.admin.projects, {});
  const [selection, setSelection] = useState<Selection | null>(null);
  const [notice, setNotice] = useState("");
  if (!data) return <PageLoading />;
  const fallback = data.projects[0];
  const current = selection ?? (fallback ? { kind: "project", path: fallback.path } as const : { kind: "connect" } as const);
  const selected = current.kind === "project" ? data.projects.find((project) => project.path === current.path) : undefined;
  const select = (next: Selection) => { setSelection(next); setNotice(""); };
  const connected = (path: string, message: string) => { setSelection({ kind: "project", path }); setNotice(message); };
  const list = {
    groups: projectGroups(data.projects), now: data.now, selectedPath: selected?.path ?? null,
    onSelect: (path: string) => select({ kind: "project", path }), onConnect: () => select({ kind: "connect" }),
  };
  return (
    <div className="flex min-h-full">
      <ProjectList {...list} />
      <div className="min-w-0 flex-1">
        <Page>
          <ProjectPicker {...list} />
          {selected
            ? <ProjectDetail key={selected.projectId} project={selected} data={data} notice={notice} onConnected={connected} onConnectAnother={() => select({ kind: "connect" })} />
            : <NewProject data={data} notice={notice} onConnected={connected} />}
        </Page>
      </div>
    </div>
  );
}

type ListProps = { groups: Group[]; now: number; selectedPath: string | null; onSelect: (path: string) => void; onConnect: () => void };

// The project list column: connected projects first, then the ones FRED has seen but that are not connected.
function ProjectList({ groups, now, selectedPath, onSelect, onConnect }: ListProps) {
  return (
    <nav aria-label="Projects" className="hidden w-55 shrink-0 flex-col gap-px self-stretch border-r px-2 py-3 lg:flex">
      {groups.length === 0 ? <p className="px-2.5 py-1.5 text-faint">No projects yet.</p> : null}
      {groups.map((group, index) => (
        <Fragment key={group.title}>
          <ListHeading className={index > 0 ? "mt-2.5" : undefined}>{group.title}</ListHeading>
          {group.projects.map((project) => <ProjectItem key={project.projectId} project={project} now={now} selected={project.path === selectedPath} onSelect={onSelect} />)}
        </Fragment>
      ))}
      <Button variant="ghost" size="lg" aria-current={selectedPath === null ? "true" : undefined} onClick={onConnect}
        className={cn("mt-2.5 justify-start text-brand hover:text-brand", selectedPath === null && "bg-muted")}>
        <PlusIcon data-icon="inline-start" />Connect a project
      </Button>
    </nav>
  );
}

// A group label inside the project list, aligned with the items' text. No primitive covers a list group heading.
function ListHeading({ className, children }: { className?: string | undefined; children: ReactNode }) {
  return <div className={cn("px-2.5 pt-1 pb-1.5 text-xs font-semibold text-faint", className)}>{children}</div>;
}

// One list row that calls `onSelect` with the project path. Shows the token's health text instead of the namespace when
// the token needs attention.
function ProjectItem({ project, now, selected, onSelect }: { project: ProjectRow; now: number; selected: boolean; onSelect: (path: string) => void }) {
  const health = tokenHealth(project.token, now);
  const attention = health.tone === "warn" || health.tone === "bad";
  return (
    <Item size="xs" render={<button type="button" />} aria-current={selected ? "true" : undefined} onClick={() => onSelect(project.path)} title={project.path}
      className={cn("text-left", selected ? "bg-muted" : "hover:bg-muted/60")}>
      <ItemContent className="min-w-0">
        <ItemTitle className={cn("w-full", !project.token && "font-normal text-muted-foreground")}><Dot tone={health.tone} className="mr-0 size-1.5" /><span className="truncate">{projectName(project.path)}</span></ItemTitle>
        <ItemDescription className={attention ? (health.tone === "bad" ? "text-bordeaux" : "text-warning") : "text-faint"}>
          <span className="block truncate">{attention ? health.text : projectNamespace(project.path)}</span>
        </ItemDescription>
      </ItemContent>
    </Item>
  );
}

// The list as a dropdown for narrow screens, where the list column is hidden.
function ProjectPicker({ groups, now, selectedPath, onSelect, onConnect }: ListProps) {
  const selected = groups.flatMap((group) => group.projects).find((project) => project.path === selectedPath);
  return (
    <div className="mb-4 lg:hidden">
      <NativeSelect aria-label="Project" value={selectedPath ?? connectValue} onChange={(event) => event.target.value === connectValue ? onConnect() : onSelect(event.target.value)}
        face={selected ? <><Dot tone={tokenHealth(selected.token, now).tone} /><span className="truncate">{selected.path}</span></> : "Connect a project"}>
        {groups.map((group) => (
          <NativeSelectOptGroup key={group.title} label={group.title}>
            {group.projects.map((project) => <NativeSelectOption key={project.projectId} value={project.path}>{project.path}</NativeSelectOption>)}
          </NativeSelectOptGroup>
        ))}
        <NativeSelectOption value={connectValue}>Connect a project</NativeSelectOption>
      </NativeSelect>
    </div>
  );
}
