import { diagnosticEvent, diagnosticSnapshot, type DiagnosticEvent, type DiagnosticSnapshot } from "@fred/contracts";
import { Context, Effect } from "effect";
import { DiagnosticSlotBusy } from "../errors";
import { accepted } from "./metadata";

export type DiagnosticInput = Omit<DiagnosticEvent, "at" | "sequence" | "phase"> & { phase?: DiagnosticEvent["phase"] };
export type DiagnosticSink = { emit: (event: DiagnosticInput) => void };
export const Diagnostics = Context.Reference<DiagnosticSink>("fred/Diagnostics", { defaultValue: () => ({ emit: () => {} }) });

const queueLimit = 128;
const batchSize = 25;
const flushInterval = "10 seconds";
const activityCoalesceMs = 10_000;
const activityRefreshMs = 60_000;
const activityKinds = new Set<DiagnosticEvent["kind"]>(["provider_activity", "tool_started", "tool_completed", "api_response"]);
const journalOnlyKinds = new Set<DiagnosticEvent["kind"]>(["tool_started", "tool_completed"]);

const selectionOf = (source: Pick<DiagnosticSnapshot, "model" | "effort">) => ({
  ...(source.model ? { model: source.model } : {}), ...(source.effort ? { effort: source.effort } : {}),
});

// One recorder per claimed job. `emit` journals every event; fork `writer` for the job's lifetime, then run `finish` once.
export function makeDiagnosticRecorder(options: {
  leaseGeneration: number;
  release?: string;
  now?: () => number;
  journal: (event: DiagnosticEvent) => void;
  send: (eventsJson: string, snapshotJson: string) => Effect.Effect<unknown, unknown>;
}) {
  const now = options.now ?? Date.now;
  const release = accepted(diagnosticEvent.shape.release, options.release);
  const correlation = release ? { release } : {};
  let sequence = 0;
  let lastActivityEvent = -Infinity;
  let dirty = false;
  let activityMoved = false;
  let sentAt = -Infinity;
  let snapshot: DiagnosticSnapshot = { phase: "queue", at: now(), droppedEvents: 0, leaseGeneration: options.leaseGeneration, ...correlation };
  const pending: DiagnosticEvent[] = [];
  const drop = (count: number) => { snapshot = { ...snapshot, droppedEvents: snapshot.droppedEvents + count }; dirty = true; };
  const emit: DiagnosticSink["emit"] = (input) => {
    try {
      const at = now();
      if (activityKinds.has(input.kind)) {
        snapshot = { ...snapshot, lastActivityAt: at };
        activityMoved = true;
      }
      if (input.kind === "provider_activity") {
        if (at - lastActivityEvent < activityCoalesceMs) return;
        lastActivityEvent = at;
      }
      const parsed = diagnosticEvent.safeParse({ ...correlation, ...selectionOf(snapshot), ...input, phase: input.phase ?? snapshot.phase, at, sequence: sequence++ });
      if (!parsed.success) { drop(1); return; }
      const event = parsed.data;
      try { options.journal(event); } catch { drop(1); }
      if (journalOnlyKinds.has(event.kind)) return;
      const failure = event.kind === "failed" || event.kind === "interrupted" ? event.failure : undefined;
      snapshot = { ...snapshot, phase: event.phase, at, ...selectionOf(event), ...(failure ? { failure } : {}) };
      dirty = true;
      if (pending.length < queueLimit) pending.push(event);
      else drop(1);
    } catch { drop(1); }
  };
  const due = (final: boolean) => pending.length > 0 || dirty || (activityMoved && (final || now() - sentAt >= activityRefreshMs));
  const sendBatch = (onBusy: "requeue" | "drop", final: boolean) => Effect.suspend(() => {
    if (!due(final)) return Effect.succeed(false);
    const batch = pending.splice(0, batchSize);
    const snapshotJson = JSON.stringify(diagnosticSnapshot.parse(snapshot));
    dirty = false;
    activityMoved = false;
    sentAt = now();
    const lost = () => {
      drop(Math.max(1, batch.length));
      try { options.journal({ kind: "diagnostics_dropped", phase: snapshot.phase, at: now() }); } catch {}
      return false;
    };
    return Effect.suspend(() => options.send(JSON.stringify(batch), snapshotJson)).pipe(
      Effect.timeout("1 second"),
      Effect.as(true),
      Effect.catch((error) => Effect.sync(() => {
        if (onBusy === "drop" || !(error instanceof DiagnosticSlotBusy)) return lost();
        pending.unshift(...batch);
        dirty = true;
        if (pending.length > queueLimit) drop(pending.splice(queueLimit).length);
        return false;
      })),
      Effect.catchDefect(() => Effect.sync(lost)),
      Effect.onInterrupt(() => Effect.sync(() => { drop(batch.length); })),
    );
  });
  const drain = (onBusy: "requeue" | "drop", final: boolean): Effect.Effect<void> => sendBatch(onBusy, final).pipe(
    Effect.flatMap((sent) => sent && pending.length > 0 ? drain(onBusy, final) : Effect.void),
  );
  const flush = drain("requeue", false);
  const writer = flush.pipe(Effect.andThen(Effect.sleep(flushInterval)), Effect.forever);
  const discardUnsent = Effect.sync(() => { if (pending.length > 0) drop(pending.splice(0).length); });
  const finish = drain("drop", true).pipe(Effect.ensuring(discardUnsent));
  return { emit, flush, writer, finish, snapshot: () => ({ ...snapshot }), pendingCount: () => pending.length };
}
