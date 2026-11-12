import { labelVerdict, markerKey, type ReviewResult } from "@fred/contracts";
import { Effect } from "effect";
import type { ClaimedJob, JobControl } from "./controller";
import { Diagnostics } from "./diagnostics/recorder";
import type { GitLabReview } from "./gitlab";

// Publishes a saved result's unacknowledged effects in order. Before each effect it renews the lease and checks the MR head;
// an outdated head reconciles a posted summary and supersedes the job.
export const publishResult = (job: ClaimedJob, result: ReviewResult, control: JobControl, gitlab: GitLabReview) => Effect.gen(function* () {
  const diagnostics = yield* Diagnostics;
  const acknowledged = new Set(job.publicationAcks.map((ack) => ack.key));
  for (const [effectIndex, effect] of result.effects.entries()) {
    if (acknowledged.has(effect.key)) continue;
    const marker = markerKey(job._id, effect.key);
    const lease = yield* control.heartbeat();
    if (!lease.publicationCurrent || !(yield* gitlab.isCurrent())) {
      if (effect.kind === "summary") {
        const summary = yield* gitlab.findSummary(marker);
        if (summary) yield* control.acknowledge(effect.key, undefined, summary.noteId);
      }
      yield* control.supersede();
      return;
    }
    yield* gitlab.ensureLabels();
    let discussionId: string | undefined;
    let noteId: string | undefined;
    const started = Date.now();
    diagnostics.emit({ kind: "publication_attempt", phase: "publish", effect: effect.kind, effectIndex });
    switch (effect.kind) {
      case "summary":
        noteId = (yield* gitlab.publishSummary({ marker, body: effect.body })).noteId;
        break;
      case "finding": {
        // GitLab rejects an inline position it cannot anchor with HTTP 400; the finding stays in the summary.
        const result = yield* gitlab.publishDiscussion({ marker, body: effect.body, ...(effect.position ? { position: effect.position } : {}) }).pipe(
          Effect.catch((error) => error.status === 400 && effect.position !== undefined ? Effect.succeed(undefined) : Effect.fail(error)),
        );
        discussionId = result?.discussionId;
        noteId = result?.noteId;
        break;
      }
      case "resolve":
        yield* gitlab.resolveDiscussion({ marker, discussionId: effect.discussionId, body: effect.body });
        break;
      case "label":
        yield* gitlab.setLabel(labelVerdict(effect.label));
        break;
    }
    yield* control.acknowledge(effect.key, discussionId, noteId);
    diagnostics.emit({ kind: "publication_acknowledged", phase: "publish", effect: effect.kind, effectIndex, durationMs: Date.now() - started });
  }
  yield* control.complete();
});
