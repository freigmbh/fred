import { describe, expect, it } from "vitest";
import { botName, tokenHealth, type ProjectRow } from "./projects";

const now = Date.parse("2026-11-06T12:00:00Z");
const token = (overrides: Partial<NonNullable<ProjectRow["token"]>>): ProjectRow["token"] => ({
  name: botName, botUsername: "project_1_bot", botUserId: "11", scopes: ["api"], accessLevel: 30,
  expiresAt: "2027-06-01", checkedAt: now, problem: null, ...overrides,
});

describe("tokenHealth", () => {
  it("reads unconnected as off, problems and past expiry as bad, near expiry and a misnamed bot as warn", () => {
    expect(tokenHealth(null, now)).toMatchObject({ tone: "off", state: "Not connected" });
    expect(tokenHealth(token({ problem: "GitLab revoked the token." }), now)).toMatchObject({ tone: "bad", text: "GitLab revoked the token." });
    expect(tokenHealth(token({ expiresAt: "2026-11-06" }), now)).toMatchObject({ tone: "bad", text: "expired" });
    expect(tokenHealth(token({ expiresAt: "2026-12-01" }), now)).toMatchObject({ tone: "warn", text: "expires in 25d" });
    expect(tokenHealth(token({ name: "review bot" }), now)).toMatchObject({ tone: "warn", text: "named review bot" });
    expect(tokenHealth(token({}), now)).toMatchObject({ tone: "ok", state: "Works", fix: null });
  });
});
