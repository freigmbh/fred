import { Effect } from "effect";
import { expect, it } from "vitest";
import { readConfig } from "./config";

it("requires the OpenRouter token without exposing other credentials", async () => {
  const result = await Effect.runPromise(readConfig({
    CONVEX_URL: "http://localhost:3210", GITLAB_URL: "http://localhost",
    WORKER_SECRET: "private-controller-secret", WORKER_MODE: "service",
  }).pipe(Effect.flip));
  expect(result.message).toContain("OPENROUTER_API_TOKEN");
  expect(result.message).not.toContain("private-");
});

it("accepts only SemVer 2.0.0 release versions and treats an empty one as unset", async () => {
  const settings = { CONVEX_URL: "http://localhost:3210", GITLAB_URL: "http://localhost", WORKER_SECRET: "secret", WORKER_MODE: "service", OPENROUTER_API_TOKEN: "token" };
  for (const version of ["0.3.1", "0.3.2-dev.4+g1a2b3c4.dirty"]) {
    expect((await Effect.runPromise(readConfig({ ...settings, FRED_VERSION: version }))).FRED_VERSION).toBe(version);
  }
  expect((await Effect.runPromise(readConfig({ ...settings, FRED_VERSION: "" }))).FRED_VERSION).toBeUndefined();
  for (const version of ["01.2.3", "1.2.3-alpha..1", "1.2.3-01", "v1.2.3"]) {
    expect((await Effect.runPromise(readConfig({ ...settings, FRED_VERSION: version }).pipe(Effect.flip))).message).toContain("FRED_VERSION");
  }
});
