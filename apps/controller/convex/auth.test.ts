import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import schema from "./schema";
import { matchesSecret } from "./sharedSecret";
import { modules } from "./test.setup";

type ValidatorJson = { type: string; value?: unknown; tableName?: string };
type Registered = { isPublic: true; isQuery?: boolean; isMutation?: boolean; isAction?: boolean; exportArgs: () => string };

beforeEach(() => {
  vi.stubEnv("WORKER_SECRET", "worker-test");
  vi.stubEnv("ADMIN_SECRET", "admin-test");
});
afterEach(() => vi.unstubAllEnvs());

// A value `validator` accepts: "x" for every string, so every secret is wrong, and an ID of a row that does not exist.
function sample(validator: ValidatorJson): unknown {
  switch (validator.type) {
    case "string": return "x";
    case "number": return 0;
    case "boolean": return false;
    case "null": return null;
    case "bytes": return new ArrayBuffer(0);
    case "literal": return validator.value;
    case "id": return `1${validator.tableName}`;
    case "array": return [];
    case "record": return {};
    case "union": return sample((validator.value as ValidatorJson[])[0]!);
    case "object": return Object.fromEntries(Object.entries(validator.value as Record<string, { fieldType: ValidatorJson; optional: boolean }>)
      .filter(([, field]) => !field.optional).map(([name, field]) => [name, sample(field.fieldType)]));
    default: throw new Error(`no sample for validator ${validator.type}`);
  }
}

function isPublicFunction(value: unknown): value is Registered {
  return typeof value === "function" && "isPublic" in value && value.isPublic === true
    && "exportArgs" in value && typeof value.exportArgs === "function";
}

it("every public function rejects a wrong secret before it reads anything", async () => {
  const t = convexTest(schema, modules);
  const checked: string[] = [];
  for (const [path, load] of Object.entries(modules)) {
    if (path.includes("/_generated/")) continue;
    const moduleName = path.replace(/^\.\//, "").replace(/\.ts$/, "");
    for (const [name, fn] of Object.entries(await load() as Record<string, unknown>)) {
      if (!isPublicFunction(fn)) continue;
      const args = sample(JSON.parse(fn.exportArgs())) as Record<string, unknown>;
      const call = fn.isQuery ? t.query(makeFunctionReference<"query">(`${moduleName}:${name}`), args)
        : fn.isMutation ? t.mutation(makeFunctionReference<"mutation">(`${moduleName}:${name}`), args)
          : t.action(makeFunctionReference<"action">(`${moduleName}:${name}`), args);
      await expect(call, `${moduleName}:${name}`).rejects.toThrow(/unauthorized/);
      checked.push(`${moduleName}:${name}`);
    }
  }
  expect(checked).toEqual(expect.arrayContaining(["jobs:claim", "findingCommands:prepare", "transcripts:store", "admin:overview", "admin:connectProject"]));
});

it("matches a secret only when one is configured and every character agrees", () => {
  expect(matchesSecret("worker-test", "worker-test")).toBe(true);
  expect(matchesSecret("worker-tesT", "worker-test")).toBe(false);
  expect(matchesSecret("worker-test-", "worker-test")).toBe(false);
  expect(matchesSecret("", "")).toBe(false);
  expect(matchesSecret("", undefined)).toBe(false);
});
