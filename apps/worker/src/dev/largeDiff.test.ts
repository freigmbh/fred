import { stage1Output, stage2Output } from "@fred/contracts";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { expect, it } from "vitest";
import { Git } from "../git";
import { makeDiffCatalog } from "../diffCatalog";
import { fixtureContext } from "../fixtures";
import { ReviewProvider, type UsageSnapshot } from "../provider";
import { detectionPrompt, maximumPromptBytes, validationPrompt } from "../prompts";
import { buildResult, validationToolSchema } from "../result";
import { openWorkspace } from "../sandbox/workspace";
import { fixtureJob } from "../testLayers";
import type { Id } from "../../../controller/convex/_generated/dataModel";
import type { DevelopmentState } from "./backend";
import { completeCatalogRead, completeScopedRead, trackDiffReads, type CatalogRead, type DiffRead } from "./diffReads";
import { FixtureProvider } from "./fixtures";
import { largeDiffFixture, largeDiffOutput } from "./largeDiff";
import { assessVerification } from "./verification";

it("reviews generated 653-file input through continued scoped patches in both real SDK stages", async () => {
  const fixture = largeDiffFixture(fixtureContext);
  expect(fixture.context.fullDiff).toHaveLength(653);
  expect(fixture.context.fullDiff.reduce((bytes, file) => bytes + Buffer.byteLength(file.diff), 0)).toBeGreaterThanOrEqual(17_000_000);
  const catalog = makeDiffCatalog(fixture.context);
  const reads: DiffRead[] = [];
  const listings: CatalogRead[] = [];
  const usage: { stage: "detect" | "validate"; sample: UsageSnapshot }[] = [];
  let checkoutPath = "";
  const { detected, validated, promptBytes } = await Effect.runPromise(Effect.gen(function* () {
    const checkout = yield* (yield* Git).checkout({ url: fixture.context.cloneUrl, sha: fixture.context.diffRefs.head_sha, token: "synthetic" });
    checkoutPath = checkout.path;
    expect(yield* Effect.promise(() => readFile(join(checkout.path, "src/counter.ts"), "utf8"))).toContain("return input || 1");
    yield* Effect.promise(() => expect(stat(join(checkout.path, "src/assertAvailable.ts"))).rejects.toMatchObject({ code: "ENOENT" }));
    const review = yield* Effect.promise(() => readFile(join(checkout.path, "REVIEW.md"), "utf8"));
    const workspace = yield* openWorkspace(checkout.path);
    const input = { context: fixture.context, botUserIds: [3], diffCatalog: catalog, instructions: { review, conventions: "" }, skills: workspace.skills.entries, previous: [] };
    const detectPrompt = yield* detectionPrompt(input);
    expect(detectPrompt.text).not.toContain("return input || 1");
    expect(detectPrompt.text).not.toContain("export function assertAvailable");
    expect(detectPrompt.text).toContain("The catalog is available through list_diffs");
    const provider = yield* ReviewProvider;
    const common = { workspace, secrets: [], model: "google/gemini-3.1-pro-preview", effort: "default" as const };
    const detected = yield* provider.run({ ...common, stage: "detect", schema: stage1Output, toolSchema: stage1Output, prompt: detectPrompt.text,
      diffCatalog: trackDiffReads(catalog, "detect", reads, listings), onUsage: (sample) => Effect.sync(() => { usage.push({ stage: "detect", sample }); }) });
    const validatePrompt = yield* validationPrompt(input, detected.output.candidates);
    const validated = yield* provider.run({ ...common, stage: "validate", schema: stage2Output, toolSchema: validationToolSchema, prompt: validatePrompt.text,
      diffCatalog: trackDiffReads(catalog, "validate", reads, listings), onUsage: (sample) => Effect.sync(() => { usage.push({ stage: "validate", sample }); }) });
    return { detected, validated, promptBytes: [detectPrompt.text, validatePrompt.text].map((prompt) => Buffer.byteLength(prompt)) };
  }).pipe(Effect.provide(Layer.merge(fixture.git, FixtureProvider("large-diff"))), Effect.scoped));
  await expect(stat(checkoutPath)).rejects.toMatchObject({ code: "ENOENT" });
  expect(detected.output).toEqual(largeDiffOutput.detect);
  expect(validated.output).toEqual(largeDiffOutput.validate);
  expect(promptBytes.every((bytes) => bytes <= maximumPromptBytes)).toBe(true);
  for (const stage of ["detect", "validate"] as const) {
    expect(completeCatalogRead(listings, stage)).toBe(true);
    expect(completeCatalogRead(listings.filter((page) => page.cursor > 0), stage)).toBe(false);
    for (const path of ["src/counter.ts", "src/assertAvailable.ts"]) {
      expect(completeScopedRead(reads, stage, path)).toBe(true);
      const pages = reads.filter((read) => read.stage === stage && read.path === path);
      expect(completeScopedRead(pages.slice(1), stage, path)).toBe(false);
      expect(completeScopedRead(pages.slice(0, -1), stage, path)).toBe(false);
    }
    expect(usage.some((row) => row.stage === stage && row.sample.final)).toBe(true);
  }
  const result = await Effect.runPromise(buildResult({ jobId: fixtureJob._id, botUserIds: [3], candidates: detected.output.candidates,
    validation: validated.output, previous: [], context: fixture.context, hints: [] }));
  const state: DevelopmentState = { jobs: [{ ...fixtureJob, status: "done", resultJson: JSON.stringify(result), publicationAcks: result.effects.map(({ key }) => ({ key })) }],
    findings: result.findings.map((finding, index) => ({ file: finding.file, title: finding.title, body: finding.body, severity: finding.severity,
      _id: `finding-${index}` as Id<"findings">, _creationTime: 1,
      jobId: fixtureJob._id, projectId: fixtureJob.projectId, mrIid: 1, provider: "fred", status: "posted" })),
    usage: (["detect", "validate"] as const).map((stage) => ({ _id: `usage-${stage}` as Id<"usageEvents">, _creationTime: 1, jobId: fixtureJob._id, developerId: fixtureJob.developerId,
      month: "2026-09", provider: "fred", model: "fixture", stage, inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, costUsd: 0, priceTableVersion: "openrouter-reported-v1" })),
    notes: [], diagnostics: [], snapshots: [] };
  const common = { id: "capture", runId: "run", mrIid: 1, provider: "fred" as const, at: 1 };
  const captured = [{ ...common, kind: "summary" as const }, { ...common, kind: "label" as const, label: "findings" as const }];
  const assess = (observed: DiffRead[]) => assessVerification(state, fixtureJob._id, "large-diff", captured, { stages: ["detect", "validate"], reads: observed, promptBytes, listings });
  expect(Object.values(assess(reads)).every(Boolean)).toBe(true);
  expect(assess([])).toMatchObject({ completeScopedCounterReads: false, completeScopedDeletionReads: false });
  state.findings = state.findings.filter((finding) => finding.file !== "src/assertAvailable.ts");
  expect(assess(reads)).toMatchObject({ acceptedDeletedModuleDefect: false });
});
