import { useAction, useMutation } from "convex/react";
import { useState, type FormEvent, type ReactNode } from "react";
import { Box, BoxFooter, BoxHeading, PageTitle, Row } from "@/components/group";
import { CallStatus, Status } from "@/components/marks";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useAdminCall, type AdminCall } from "@/lib/admin";
import { api, type Projects } from "@/lib/api";
import { projectName } from "@/lib/display";
import { date, time } from "@/lib/format";
import { botName, expiryText, pipelineValid, roleName, samePipeline, tokenHealth, type Pipeline, type ProjectRow } from "@/lib/projects";
import { CatalogRow, ConnectBox, FirstPipelineBox, PipelineRows } from "./project-forms";

type Token = NonNullable<ProjectRow["token"]>;
type OnConnected = (path: string, notice: string) => void;

// The selected project: title row with Check and Connect another, then its Token, Review pipeline, and Transcripts boxes.
export function ProjectDetail({ project, data, notice, onConnected, onConnectAnother }: {
  project: ProjectRow; data: Projects; notice: string; onConnected: OnConnected; onConnectAnother: () => void;
}) {
  const [replacing, setReplacing] = useState(false);
  const tokenCall = useAdminCall();
  const { token } = project;
  return (
    <>
      <PageTitle title={projectName(project.path)} fact={project.path}>
        <Notice text={notice} />
        {token ? <CheckButton project={project} call={tokenCall} /> : null}
        <Button onClick={onConnectAnother}>Connect another</Button>
      </PageTitle>
      <TokenAndPipeline target={project} data={data}
        tokenBox={token && !replacing ? <TokenBox project={project} token={token} now={data.now} call={tokenCall} onReplace={() => setReplacing(true)} /> : null}
        onConnected={(path, text) => { setReplacing(false); onConnected(path, text); }}
        onCancel={token ? () => setReplacing(false) : undefined} />
      <BoxHeading title="Transcripts" className="mt-5" />
      <TranscriptBox project={project} />
    </>
  );
}

// The right pane for a project FRED has not seen yet: the connect form and the first pipeline under their own title.
export function NewProject({ data, notice, onConnected }: { data: Projects; notice: string; onConnected: OnConnected }) {
  return (
    <>
      <PageTitle title="Connect a project" fact={`A GitLab project access token named ${botName}`}><Notice text={notice} /></PageTitle>
      <TokenAndPipeline target={null} data={data} tokenBox={null} onConnected={onConnected} />
    </>
  );
}

function Notice({ text }: { text: string }) {
  return text ? <span className="text-brand" role="status">{text}</span> : null;
}

// The Token box and the Review pipeline box. The Token box is `tokenBox`, or the connect form when that is null; `target` is
// null for a project FRED has not seen, and `onCancel` is present while replacing a token that still works. Without a saved
// pipeline, the pipeline box edits the first pipeline, which the connect sends with the token.
function TokenAndPipeline({ target, data, tokenBox, onConnected, onCancel }: {
  target: ProjectRow | null; data: Projects; tokenBox: ReactNode; onConnected: OnConnected; onCancel?: (() => void) | undefined;
}) {
  const [firstPipeline, setFirstPipeline] = useState<Pipeline>(data.defaultPipeline);
  const connect = useAdminCall();
  const saved = target?.stageModels ?? null;
  return (
    <>
      <BoxHeading title="Token" />
      {tokenBox ?? <ConnectBox target={target} data={data} pipeline={saved ? null : firstPipeline} call={connect} onConnected={onConnected} onCancel={onCancel} />}
      <BoxHeading title="Review pipeline" className="mt-5" />
      {target && saved
        ? <PipelineEditor key={`${target.projectId}:${target.pipelineRevision}`} project={target} pipeline={saved} data={data} />
        : <FirstPipelineBox pipeline={firstPipeline} data={data} connecting={connect.busy} onChange={setFirstPipeline} />}
    </>
  );
}

// Rechecks the token with GitLab now. Its outcome shows next to the Token box's actions through the shared `call`.
function CheckButton({ project, call }: { project: ProjectRow; call: AdminCall }) {
  const checkProject = useAction(api.admin.checkProject);
  const check = () => call.run(async (adminSecret) => {
    const result = await checkProject({ adminSecret, projectId: project.projectId });
    return result.problem ? "Problem found" : "Token works";
  }, "Check failed");
  return <Button variant="outline" disabled={call.busy} onClick={() => void check()}>{call.busy ? "Checking…" : "Check"}</Button>;
}

// A connected token's details with Replace and Disconnect. `call` carries the outcome of Check and Disconnect.
function TokenBox({ project, token, now, call, onReplace }: { project: ProjectRow; token: Token; now: number; call: AdminCall; onReplace: () => void }) {
  const health = tokenHealth(token, now);
  return (
    <Box>
      <Row label="Status" sub={health.fix ? <span className={health.tone === "bad" ? "text-bordeaux" : "text-warning"} role={health.tone === "bad" ? "alert" : undefined}>{health.fix}</span> : undefined}
        action={<TokenActions project={project} call={call} onReplace={onReplace} />}>
        <Status tone={health.tone}>{health.state}</Status>
      </Row>
      <Row label="Bot" sub={`Project access token "${token.name}" · ${roleName(token.accessLevel)}`}>@{token.botUsername}</Row>
      <Row label="Expiry" sub={token.expiresAt ? date(token.expiresAt) : undefined}>{expiryText(token.expiresAt, now)}</Row>
      <Row label="Last checked">{time(token.checkedAt)}</Row>
      <Row label="Scopes"><span className="flex flex-wrap gap-1">{token.scopes.map((scope) => <Badge key={scope} variant="secondary">{scope}</Badge>)}</span></Row>
    </Box>
  );
}

// Replace and two-step Disconnect, with the outcome of the last Check or Disconnect before them. A successful disconnect
// needs no message: the project shows its connect form.
function TokenActions({ project, call, onReplace }: { project: ProjectRow; call: AdminCall; onReplace: () => void }) {
  const disconnectProject = useMutation(api.admin.disconnectProject);
  const [confirming, setConfirming] = useState(false);
  const disconnect = () => call.run(async (adminSecret) => {
    await disconnectProject({ adminSecret, projectId: project.projectId });
    return "";
  }, "Disconnect failed");
  return (
    <>
      <CallStatus call={call} />
      {confirming ? (
        <>
          <Button variant="outline" disabled={call.busy} onClick={() => setConfirming(false)}>Keep</Button>
          <Button variant="destructive" disabled={call.busy} onClick={() => void disconnect()}>Confirm disconnect</Button>
        </>
      ) : (
        <>
          <Button variant="outline" disabled={call.busy} onClick={onReplace}>Replace…</Button>
          <Button variant="destructive" disabled={call.busy} onClick={() => setConfirming(true)}>Disconnect…</Button>
        </>
      )}
    </>
  );
}

// Edits the saved pipeline. Key it by project and pipelineRevision so the draft resets after each save. A failed save keeps
// the edits; a stale revision is refused by the controller and reported.
function PipelineEditor({ project, pipeline, data }: { project: ProjectRow; pipeline: Pipeline; data: Projects }) {
  const savePipeline = useMutation(api.admin.savePipeline);
  const call = useAdminCall();
  const [draft, setDraft] = useState(pipeline);
  const changed = !samePipeline(draft, pipeline);
  const valid = pipelineValid(draft, data.catalog);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!changed || !valid) return;
    await call.run(async (adminSecret) => {
      await savePipeline({ adminSecret, projectId: project.projectId, stageModels: draft, expectedRevision: project.pipelineRevision });
      return "Saved";
    }, "Save failed. Your edits are kept.");
  }
  return (
    <form onSubmit={save}>
      <Box>
        <fieldset disabled={call.busy} className="min-w-0 divide-y"><legend className="sr-only">Review pipeline of {project.path}</legend>
          <PipelineRows idPrefix={project.projectId} pipeline={draft} catalog={data.catalog} onChange={(next) => { setDraft(next); call.reset(); }} />
        </fieldset>
        <CatalogRow data={data} />
        <BoxFooter status={<CallStatus call={call} />}>
          <Button type="button" variant="ghost" disabled={!changed || call.busy} onClick={() => { setDraft(pipeline); call.reset(); }}>Reset</Button>
          <Button type="submit" disabled={!changed || !valid || call.busy}>Save pipeline</Button>
        </BoxFooter>
      </Box>
    </form>
  );
}

// The project's transcript collection switch. Switching on asks for confirmation first, because transcripts hold source code.
function TranscriptBox({ project }: { project: ProjectRow }) {
  const setCollection = useMutation(api.admin.setTranscriptCollection);
  const call = useAdminCall();
  const [confirming, setConfirming] = useState(false);
  const collecting = project.collectTranscripts;
  const toggle = (enabled: boolean) => call.run(async (adminSecret) => {
    await setCollection({ adminSecret, projectId: project.projectId, enabled });
    setConfirming(false);
    return "";
  }, "Switch failed");
  return (
    <Box>
      <Row label="Collect"
        sub={confirming
          ? <span className="text-warning">Transcripts hold the source code, diffs, and discussions the agent read. Tell the project's team before you switch on.</span>
          : "Each stage's full model conversation · applies to reviews queued from now on · download under Reviews"}
        action={<>
          <CallStatus call={call} />
          {confirming ? (
            <>
              <Button variant="outline" disabled={call.busy} onClick={() => setConfirming(false)}>Keep off</Button>
              <Button disabled={call.busy} onClick={() => void toggle(true)}>Confirm collect</Button>
            </>
          ) : (
            <Switch aria-label="Collect transcripts" checked={collecting} disabled={call.busy} onCheckedChange={(enabled) => enabled ? setConfirming(true) : void toggle(false)} />
          )}
        </>}>
        {collecting ? <Status tone="ok">Collecting</Status> : "Off"}
      </Row>
    </Box>
  );
}
