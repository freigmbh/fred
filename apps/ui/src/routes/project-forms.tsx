import { useAction } from "convex/react";
import { useState, type FormEvent } from "react";
import { Box, BoxFooter, Row } from "@/components/group";
import { CallStatus, ModelLabIcon, Status } from "@/components/marks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption, SelectPrefix } from "@/components/ui/native-select";
import { useAdminCall, type AdminCall } from "@/lib/admin";
import { api, type Projects } from "@/lib/api";
import { time } from "@/lib/format";
import { modelName } from "@/lib/labs";
import { botName, pipelineValid, stages, supportsEffort, type CatalogModel, type Pipeline, type ProjectRow } from "@/lib/projects";

type Selection = Pipeline["detect"];

// A catalog label without its lab prefix: "OpenAI: GPT-6 Astra" becomes "GPT-6 Astra". Labels without a prefix stay whole.
function shortLabel(label: string) {
  const colon = label.indexOf(": ");
  return colon < 0 ? label : label.slice(colon + 2);
}

// The Detect and Validate rows of a pipeline box: a model dropdown and an effort dropdown each. Unavailable saved choices
// stay visible and disabled. One row says so while the catalog is empty.
export function PipelineRows({ idPrefix, pipeline, catalog, onChange }: { idPrefix: string; pipeline: Pipeline; catalog: CatalogModel[]; onChange: (pipeline: Pipeline) => void }) {
  if (catalog.length === 0) return <Row label="Models"><span className="text-faint">Refresh the catalog to choose models.</span></Row>;
  return stages.map((stage) => (
    <StageRow key={stage.id} id={`${idPrefix}-${stage.id}`} stage={stage} selection={pipeline[stage.id]} catalog={catalog}
      onChange={(selection) => onChange({ ...pipeline, [stage.id]: selection })} />
  ));
}

function StageRow({ id, stage, selection, catalog, onChange }: { id: string; stage: (typeof stages)[number]; selection: Selection; catalog: CatalogModel[]; onChange: (selection: Selection) => void }) {
  const selected = catalog.find((model) => model.id === selection.model);
  const context = `for ${stage.label.toLowerCase()}`;
  function selectModel(modelId: string) {
    const model = catalog.find((candidate) => candidate.id === modelId);
    if (model) onChange({ model: model.id, effort: supportsEffort(model, selection.effort) ? selection.effort : model.defaultEffort });
  }
  return (
    <Row label={<Label htmlFor={`${id}-model`} title={stage.description}>{stage.label}</Label>}>
      <div className="flex flex-wrap items-center gap-2">
        <NativeSelect id={`${id}-model`} aria-label={`Model ${context}`} value={selection.model} className="max-w-72" title={selected?.label ?? selection.model}
          face={<><ModelLabIcon model={selection.model} /><span className="truncate">{selected ? shortLabel(selected.label) : `${modelName(selection.model)} (gone)`}</span></>}
          onChange={(event) => selectModel(event.target.value)}>
          {!selected ? <NativeSelectOption value={selection.model} disabled>{selection.model} (gone)</NativeSelectOption> : null}
          {catalog.map((model) => <NativeSelectOption key={model.id} value={model.id}>{model.label}</NativeSelectOption>)}
        </NativeSelect>
        <NativeSelect id={`${id}-effort`} aria-label={`Effort ${context}`} value={selection.effort} disabled={!selected}
          face={<><SelectPrefix>Effort</SelectPrefix>{supportsEffort(selected, selection.effort) ? selection.effort : `${selection.effort}?`}</>}
          onChange={(event) => onChange({ ...selection, effort: event.target.value })}>
          {!supportsEffort(selected, selection.effort) ? <NativeSelectOption value={selection.effort} disabled>{selection.effort}?</NativeSelectOption> : null}
          {selected?.efforts.map((effort) => <NativeSelectOption key={effort} value={effort}>{effort}</NativeSelectOption>)}
        </NativeSelect>
      </div>
    </Row>
  );
}

// The catalog's size and age with its refresh action, as the last row of a pipeline box.
export function CatalogRow({ data }: { data: Projects }) {
  const refreshModels = useAction(api.admin.refreshModels);
  const call = useAdminCall();
  const refresh = () => call.run(async (adminSecret) => `${(await refreshModels({ adminSecret })).count} models`, "Refresh failed");
  return (
    <Row label="Catalog" sub={data.fetchedAt ? `refreshed ${time(data.fetchedAt)}` : undefined}
      action={<><CallStatus call={call} /><Button variant="outline" disabled={call.busy} onClick={() => void refresh()}>{call.busy ? "Refreshing…" : "Refresh"}</Button></>}>
      {data.fetchedAt ? `OpenRouter · ${data.catalog.length} models` : "No model catalog yet"}
    </Row>
  );
}

// The pipeline a first connect saves with the token, in its own box. `connecting` locks it while a connect that already sent
// it is pending.
export function FirstPipelineBox({ pipeline, data, connecting, onChange }: { pipeline: Pipeline; data: Projects; connecting: boolean; onChange: (pipeline: Pipeline) => void }) {
  return (
    <Box>
      <fieldset disabled={connecting} className="min-w-0 divide-y"><legend className="sr-only">First review pipeline</legend>
        <PipelineRows idPrefix="first" pipeline={pipeline} catalog={data.catalog} onChange={onChange} />
      </fieldset>
      <CatalogRow data={data} />
    </Box>
  );
}

// The Token box while connecting: paste a project access token and connect its project. `target` limits a replacement to
// one project. `pipeline` is the first pipeline to save, edited in the box below; pass null when the project already has
// one. `call` comes from the parent so the pipeline box can lock while it is busy. `onConnected` receives the connected
// project's path and the confirmation to show. `onCancel` is present while replacing a token that still works.
export function ConnectBox({ target, data, pipeline, call, onConnected, onCancel }: {
  target: ProjectRow | null; data: Projects; pipeline: Pipeline | null; call: AdminCall;
  onConnected: (path: string, notice: string) => void; onCancel?: (() => void) | undefined;
}) {
  const connectProject = useAction(api.admin.connectProject);
  const [token, setToken] = useState("");
  const pipelineOk = pipeline === null || pipelineValid(pipeline, data.catalog);
  const valid = token.trim().length > 0 && pipelineOk;
  const replacing = Boolean(target?.token);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!valid) return;
    await call.run(async (adminSecret) => {
      const result = await connectProject({ adminSecret, token: token.trim(), ...(pipeline ? { stageModels: pipeline } : {}),
        ...(target ? { gitlabProjectId: target.gitlabProjectId } : {}) });
      setToken("");
      onConnected(result.path, ["Connected.", result.createdLabels.length ? "Review labels created." : "",
        result.avatarSet ? "" : "GitLab refused the bot's avatar."].filter(Boolean).join(" "));
      return "";
    }, "Could not connect. Try again.");
  }

  return (
    <form onSubmit={submit}>
      <Box>
        <fieldset disabled={call.busy} className="min-w-0 divide-y">
          <legend className="sr-only">{replacing ? `Replace the token of ${target?.path}` : "Connect a project"}</legend>
          {target && !replacing ? <Row label="Status"><Status tone="off">Not connected</Status></Row> : null}
          <Row label={<Label htmlFor="project-token">Token</Label>} sub={`A GitLab project access token named ${botName}`}>
            <Input id="project-token" type="password" autoComplete="off" spellCheck={false} value={token} placeholder="glpat-…" className="max-w-md"
              onChange={(event) => { setToken(event.target.value); call.reset(); }} />
          </Row>
        </fieldset>
        <BoxFooter status={call.error ? <CallStatus call={call} /> : !pipelineOk ? <span className="text-faint">Choose a model for each stage below.</span> : null}>
          {onCancel ? <Button type="button" variant="ghost" disabled={call.busy} onClick={onCancel}>Cancel</Button> : null}
          <Button type="submit" disabled={!valid || call.busy}>{call.busy ? "Checking…" : replacing ? "Replace" : "Connect"}</Button>
        </BoxFooter>
      </Box>
    </form>
  );
}
