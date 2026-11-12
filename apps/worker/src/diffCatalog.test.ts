import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { makeDiffCatalog } from "./diffCatalog";
import { maximumPromptBytes } from "./prompts";
import { fixtureContext } from "./fixtures";

const file = (diff: string, path = "file.ts") => ({ ...fixtureContext.fullDiff[0]!, old_path: path, new_path: path, diff });
const pageSchema = z.object({
  inlineAnchors: z.boolean(),
  lines: z.array(z.object({ line: z.number(), column: z.number(), oldLine: z.number().nullable(), newLine: z.number().nullable(), text: z.string() })),
  nextCursor: z.object({ line: z.number(), column: z.number() }).nullable(),
});
const page = async (catalog: ReturnType<typeof makeDiffCatalog>, input: unknown) => pageSchema.parse(JSON.parse(await Effect.runPromise(catalog.read(input))));

describe("diff catalog", () => {
  it("pages an oversized manifest losslessly, including a row too long for one page", async () => {
    const files = Array.from({ length: 1200 }, (_, index) => file("@@ -0,0 +1 @@\n+ok\n", index === 0
      ? `${'é😀"\\'.repeat(2000)}.ts`
      : `generated/${"nested/".repeat(30)}${index}.ts`));
    const catalog = makeDiffCatalog({ fullDiff: files, reviewDiff: files });
    const rendered = await Effect.runPromise(catalog.render(maximumPromptBytes));
    expect(rendered.text).toContain("1200 entries");
    expect(rendered.text).toContain("list_diffs");
    expect(Buffer.byteLength(rendered.text)).toBeLessThanOrEqual(maximumPromptBytes);
    const listing = z.object({ text: z.string(), nextCursor: z.number().nullable() });
    let cursor: number | null = 0;
    let reconstructed = "";
    while (cursor !== null) {
      const encoded = await Effect.runPromise(catalog.list({ cursor, maxBytes: 1024 }));
      expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(1024);
      const page = listing.parse(JSON.parse(encoded));
      expect(page.text.length).toBeGreaterThan(0);
      expect(Buffer.from(page.text).toString("utf8")).toBe(page.text);
      if (page.nextCursor !== null) expect(page.nextCursor).toBeGreaterThan(cursor);
      reconstructed += page.text;
      cursor = page.nextCursor;
    }
    const entries = z.array(z.object({ id: z.string(), path: z.string() })).parse(reconstructed.split("\n").map((row) => JSON.parse(row)));
    expect(entries).toEqual(files.map((file, index) => ({ id: `d${index + 1}`, path: file.new_path })));
    expect((await page(catalog, { id: entries.at(-1)!.id })).lines.at(-1)?.text).toBe("+ok\n");
    await expect(Effect.runPromise(catalog.list({ cursor: reconstructed.length + 1 }))).rejects.toMatchObject({ _tag: "SandboxError" });
  });

  it("uses the same deferred-range hint when stage budgets differ", async () => {
    const files = Array.from({ length: 3 }, (_, index) => file(`@@ -0,0 +1 @@\n+${"x".repeat(2000)}\n`, `${index}.ts`));
    const catalog = makeDiffCatalog({ fullDiff: files, reviewDiff: files });
    const smaller = await Effect.runPromise(catalog.render(3000));
    const larger = await Effect.runPromise(catalog.render(6000));
    expect(smaller.text).not.toBe(larger.text);
    expect(smaller.hints).toHaveLength(1);
    expect(smaller.hints).toEqual(larger.hints);
  });

  it("keeps every file available while bounding a 17 MB diff's inline input", async () => {
    const files = Array.from({ length: 653 }, (_, index) => file(`@@ -0,0 +1 @@\n+${"x".repeat(index < 4 ? 4_300_000 : 20)}\n`, `simulation/assets/imported/models/flight-trajectories/generated/reference/catalog/asset-${index}.txt`));
    const catalog = makeDiffCatalog({ fullDiff: files, reviewDiff: files });
    const rendered = await Effect.runPromise(catalog.render(maximumPromptBytes));
    expect(catalog.entries).toHaveLength(653);
    expect(catalog.entries.reduce((bytes, entry) => bytes + entry.full!.bytes, 0)).toBeGreaterThan(17_000_000);
    expect(Buffer.byteLength(rendered.text)).toBeLessThanOrEqual(maximumPromptBytes);
    for (const entry of catalog.entries) expect(rendered.text).toContain(`"id":"${entry.id}"`);
    expect(rendered.hints).toHaveLength(1);
    expect((await page(catalog, { id: "d1" })).nextCursor).not.toBeNull();
  });

  it("continues through long Unicode lines losslessly within the encoded response budget", async () => {
    const text = `@@ -1 +1 @@\n-before\n+${'é😀"\\'.repeat(4000)}\n`;
    const catalog = makeDiffCatalog({ fullDiff: [file(text)], reviewDiff: [file(text)] });
    let cursor: { line: number; column: number } | null = { line: 0, column: 0 };
    let reconstructed = "";
    let continuations = 0;
    while (cursor) {
      const encoded = await Effect.runPromise(catalog.read({ id: "d1", cursor, maxBytes: 1024 }));
      expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(1024);
      const result = pageSchema.parse(JSON.parse(encoded));
      expect(result.lines.length).toBeGreaterThan(0);
      for (const fragment of result.lines) {
        expect(Buffer.from(fragment.text).toString("utf8")).toBe(fragment.text);
        if (fragment.line === 2) { expect(fragment.oldLine).toBeNull(); expect(fragment.newLine).toBe(1); }
      }
      reconstructed += result.lines.map((line) => line.text).join("");
      cursor = result.nextCursor;
      continuations++;
      if (continuations > 1000) throw new Error("Diff cursor failed to progress");
    }
    expect(reconstructed).toBe(text);
    expect(continuations).toBeGreaterThan(1);
  });

  it("continues losslessly when the next line number gains a digit at the page boundary", async () => {
    const text = `@@ -0,0 +1,10 @@\n+${"x".repeat(285)}\n${"+x\n".repeat(9)}`;
    const catalog = makeDiffCatalog({ fullDiff: [file(text)], reviewDiff: [file(text)] });
    let cursor: { line: number; column: number } | null = { line: 0, column: 0 };
    let reconstructed = "";
    while (cursor) {
      const encoded = await Effect.runPromise(catalog.read({ id: "d1", cursor, maxBytes: 1024 }));
      expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(1024);
      const result = pageSchema.parse(JSON.parse(encoded));
      expect(result.lines.length).toBeGreaterThan(0);
      reconstructed += result.lines.map((line) => line.text).join("");
      expect(reconstructed.length).toBeLessThanOrEqual(text.length);
      cursor = result.nextCursor;
    }
    expect(reconstructed).toBe(text);
  });

  it("preserves deletion coordinates and separates incremental and full patches", async () => {
    const full = file("@@ -30,2 +30 @@\n-removed\n retained\n");
    const scope = file("@@ -30 +30 @@\n-prior\n+retained\n");
    const catalog = makeDiffCatalog({ fullDiff: [full], reviewDiff: [scope] });
    expect(catalog.entries[0]?.shared).toBe(false);
    const fullPage = await page(catalog, { id: "d1", range: "full" });
    expect(fullPage.lines[1]).toMatchObject({ oldLine: 30, newLine: null, text: "-removed\n" });
    const scopePage = await page(catalog, { id: "d1", range: "scope" });
    expect(scopePage.lines[2]).toMatchObject({ oldLine: null, newLine: 30, text: "+retained\n" });
  });

  it("distinguishes rename IDs from reused paths and keeps recovered data summary-only", async () => {
    const renamed = { ...file("@@ -1 +1 @@\n-old\n+renamed\n", "new.ts"), old_path: "old.ts", renamed_file: true };
    const reused = { ...file("", "old.ts"), recovery: { context: "Binary files a/old.ts and b/old.ts differ" } };
    const catalog = makeDiffCatalog({ fullDiff: [renamed, reused], reviewDiff: [renamed, reused] });
    expect(catalog.entries.map((entry) => entry.id)).toEqual(["d1", "d2"]);
    expect((await page(catalog, { id: "d2" })).inlineAnchors).toBe(false);
    expect((await page(catalog, { id: "d1" })).lines[2]?.text).toBe("+renamed\n");
  });

  it("keeps range-specific anchor eligibility when patch text is identical", async () => {
    const text = "@@ -1 +1 @@\n-old\n+new\n";
    const scope = file(text);
    const catalog = makeDiffCatalog({ fullDiff: [{ ...scope, recovery: { context: text } }], reviewDiff: [scope] });
    expect(catalog.entries[0]?.shared).toBe(false);
    expect((await page(catalog, { id: "d1", range: "full" })).inlineAnchors).toBe(false);
    expect((await page(catalog, { id: "d1" })).inlineAnchors).toBe(true);
  });

  it("keeps continued pages and metadata stable after caller-owned diffs change", async () => {
    const text = `@@ -1 +1 @@\n-old\n+${"original".repeat(500)}\n`;
    const source = { ...file(text), recovery: { context: text } };
    const files = [source];
    const catalog = makeDiffCatalog({ fullDiff: files, reviewDiff: files });
    const first = await page(catalog, { id: "d1", maxBytes: 1024 });
    source.diff = "replacement";
    source.recovery.context = "changed recovery";
    source.new_path = "changed.ts";
    files.splice(0);
    let reconstructed = first.lines.map((line) => line.text).join("");
    let next = first.nextCursor;
    while (next) {
      const result = await page(catalog, { id: "d1", cursor: next, maxBytes: 1024 });
      reconstructed += result.lines.map((line) => line.text).join("");
      next = result.nextCursor;
    }
    expect(reconstructed).toBe(text);
    expect(catalog.entries[0]).toMatchObject({ newPath: "file.ts", scope: { bytes: Buffer.byteLength(text), inlineAnchors: false } });
    expect(Object.isFrozen(catalog.entries)).toBe(true);
    expect(Object.isFrozen(catalog.entries[0])).toBe(true);
    expect(Object.isFrozen(catalog.entries[0]?.scope)).toBe(true);
  });

  it("handles empty diffs and rejects invalid IDs, ranges and cursor positions", async () => {
    const catalog = makeDiffCatalog({ fullDiff: [file("")], reviewDiff: [] });
    expect(await page(catalog, { id: "d1", range: "full" })).toMatchObject({ lines: [], nextCursor: null });
    for (const input of [{ id: "d1" }, { id: "../../etc/passwd" }, { id: "d1", range: "full", cursor: { line: 1, column: 0 } }]) {
      await expect(Effect.runPromise(catalog.read(input))).rejects.toMatchObject({ _tag: "SandboxError" });
    }
  });
});
