import { commandDecisionMarkerKey, decisionPublication, failureSummary, summaryMarkerKey } from "@fred/contracts";
import { Effect } from "effect";
import { claimSecrets, runClaim } from "./claim";
import { Controller, type ClaimedCommand } from "./controller";
import { ParseError } from "./errors";
import { GitLab } from "./gitlab";

// Publishes one human finding command with the claim's project token, without provider calls.
export const runFindingCommand = (command: ClaimedCommand) => Effect.gen(function* () {
  const control = (yield* Controller).forCommand(command);
  const gitlabService = yield* GitLab;
  yield* runClaim(command, {
    secrets: yield* claimSecrets(command),
    heartbeat: control.heartbeat,
    failed: (_error, failure) => control.fail(failureSummary(failure)).pipe(Effect.ignore, Effect.as("failed" as const)),
    work: (scope) => Effect.gen(function* () {
      const gitlab = gitlabService.forMr(scope);
      let saved = command.resultJson;
      if (saved === undefined) {
        const findings = yield* control.context();
        for (const jobId of new Set(findings.filter((finding) => !finding.summaryNoteId && (finding.status === "pending" || finding.status === "posted")).map((finding) => finding.jobId))) {
          const summary = yield* gitlab.findSummary(summaryMarkerKey(jobId));
          if (summary) yield* control.reconcileSummary(jobId, summary.noteId);
        }
        const prepared = yield* control.prepare();
        if (prepared === null) return;
        saved = prepared;
      }
      const publication = yield* Effect.try({ try: () => decisionPublication.parse(JSON.parse(saved)), catch: () => new ParseError({ message: "Saved finding command publication is invalid" }) });
      if (!command.publicationAcks.includes("decision")) {
        yield* control.heartbeat();
        const reply = { marker: commandDecisionMarkerKey(command._id), body: publication.body };
        if (publication.discussionId) yield* gitlab.resolveDiscussion({ ...reply, discussionId: publication.discussionId, resolved: publication.resolved });
        else yield* gitlab.publishSummary(reply);
        yield* control.acknowledge("decision");
      }
      if (!command.publicationAcks.includes("label")) {
        yield* control.heartbeat();
        yield* gitlab.setLabel(publication.label);
        yield* control.acknowledge("label");
      }
    }),
  });
});
