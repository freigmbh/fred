import type { Candidate } from "@fred/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeDiffCatalog } from "./diffCatalog";
import type { Id } from "../../controller/convex/_generated/dataModel";
import type { PreviousFinding } from "./controller";
import { detectionPrompt, maximumPromptBytes, promptDiscussions, validationPrompt } from "./prompts";
import { fixtureContext } from "./fixtures";
import { fixtureJob } from "./testLayers";

const skills = [{ name: "security", description: "Review access checks", path: ".agents/skills/security/SKILL.md" }];
const input = { context: fixtureContext, botUserIds: [3], instructions: { review: "Check correctness", conventions: "Use TypeScript" }, skills, previous: [], diffCatalog: makeDiffCatalog(fixtureContext) };
const candidate = { file: "src/counter.ts", line: 2, severity: "should_fix", title: "Preserve zero", body: "Zero is a valid input." } satisfies Candidate;

describe("review prompt scope", () => {
  it.each(["detect", "validate"] as const)("includes shared small patches once in %s with complete rules and stage context", async (stage) => {
    const { text } = await Effect.runPromise(stage === "detect" ? detectionPrompt(input) : validationPrompt(input, [candidate]));
    const patch = fixtureContext.fullDiff[0]!.diff;
    expect(text.split(patch)).toHaveLength(2);
    expect(text).toContain(`d1 (scope and full):\ndiff --git a/src/counter.ts b/src/counter.ts\n${patch}`);
    expect(text).toContain(`Available repository skills:\n${JSON.stringify({ skills })}`);
    expect(text).toContain(input.instructions.review);
    expect(text).toContain(input.instructions.conventions);
    if (stage === "validate") expect(text).toContain(`CANDIDATES:\n${JSON.stringify([{ index: 0, ...candidate }])}`);
    else expect(text).toContain("STAGE 1: Detect candidate findings.");
  });

  it("keeps earlier and reverted changes in their original ranges", async () => {
    const earlier = { ...fixtureContext.fullDiff[0]!, old_path: "earlier.ts", new_path: "earlier.ts", diff: "@@ -1 +1 @@\n-old\n+earlier change" };
    const reverted = { ...earlier, old_path: "reverted.ts", new_path: "reverted.ts" };
    const context = { ...fixtureContext, fullDiff: [...fixtureContext.fullDiff, earlier], reviewDiff: [...fixtureContext.reviewDiff, reverted] };
    const diffCatalog = makeDiffCatalog(context);
    const { text } = await Effect.runPromise(detectionPrompt({ ...input, context, diffCatalog }));
    expect(diffCatalog.entries.find((entry) => entry.newPath === "earlier.ts")?.scope).toBeNull();
    expect(diffCatalog.entries.find((entry) => entry.newPath === "reverted.ts")?.full).toBeNull();
    expect(text).toContain("only its changed scope lines qualify");
    expect(text).toContain("d2 (full):");
    expect(text).toContain("d3 (scope):");
  });

  it("renders only the discussions a stage can act on, keeping every other-bot summary", async () => {
    const bot = { id: 3 };
    const other = { id: 4 };
    const human = { id: 5 };
    const note = (id: number, author: { id: number }, body: string, flags: { system?: boolean; resolvable?: boolean; resolved?: boolean } = {}) => ({ id, author, body, ...flags });
    const summary = (id: number, author: { id: number }) => ({ id: `summary-${id}`, notes: [note(id, author, `review <!-- fred-review:${id} -->`)] });
    const discussions = [
      { id: "system-only", notes: [note(1, human, "added 1 commit", { system: true })] },
      { id: "open-thread", notes: [note(2, bot, "concern", { resolvable: true }), note(3, human, "changed this line", { system: true }), note(4, human, "reply")] },
      { id: "resolved-open-finding", notes: [note(5, bot, "concern", { resolvable: true, resolved: true }), note(6, human, "won't fix")] },
      { id: "resolved-fixed", notes: [note(7, other, "concern", { resolvable: true, resolved: true }), note(8, other, "Fixed in abc")] },
      summary(9, bot), summary(10, other), summary(11, bot), summary(14, other),
      { id: "failure", notes: [note(12, bot, "AI review failed <!-- fred-note:x -->")] },
      { id: "human-comment", notes: [note(13, human, "please also check the tests")] },
    ];
    const finding: PreviousFinding = {
      _id: "finding-one" as Id<"findings">, _creationTime: 1, jobId: "earlier-job" as Id<"reviewJobs">, projectId: fixtureJob.projectId, mrIid: 1, provider: "fred",
      file: "counter.ts", title: "Concern", body: "Evidence", severity: "should_fix", status: "posted", disposition: "open", resultIndex: 0, reference: "earlier-job/0", discussionId: "resolved-open-finding",
    };
    const context = { ...fixtureContext, discussions };
    const kept = promptDiscussions(discussions, [3], [finding]);
    expect(kept.map((thread) => thread.id)).toEqual(["open-thread", "resolved-open-finding", "summary-10", "summary-14", "human-comment"]);
    expect(kept[0]?.notes.map((entry) => entry.id)).toEqual([2, 4]);
    const { text } = await Effect.runPromise(detectionPrompt({ ...input, context, previous: [finding], diffCatalog: makeDiffCatalog(context) }));
    expect(text).toContain(`EXISTING DISCUSSIONS (all authors; system notes, resolved threads outside this bot's open findings, FRED status notes, and this bot's own summaries are omitted):\n${JSON.stringify(kept)}`);
    expect(text).not.toContain("resolved-fixed");
  });

  it("hides summaries written by any current or former FRED bot of the project", () => {
    const summary = (authorId: number) => ({ id: `summary-${authorId}`, notes: [{ id: authorId, author: { id: authorId }, body: `review <!-- fred-review:${authorId} -->` }] });
    const kept = promptDiscussions([summary(2), summary(3), summary(4)], [2, 3], []);
    expect(kept.map((thread) => thread.id)).toEqual(["summary-4"]);
  });

  it.each([
    ["detect", "review rules"], ["validate", "review rules"], ["detect", "skill catalog"],
  ] as const)("rejects oversized non-diff inputs in %s (%s) instead of truncating them", async (stage, oversized) => {
    const filler = "x".repeat(maximumPromptBytes);
    const large = oversized === "review rules"
      ? { ...input, instructions: { ...input.instructions, review: filler } }
      : { ...input, skills: [{ ...skills[0]!, description: filler }] };
    await expect(Effect.runPromise(stage === "detect" ? detectionPrompt(large) : validationPrompt(large, [candidate])))
      .rejects.toMatchObject({ diagnostic: { code: "review_input_too_large" } });
  });
});
