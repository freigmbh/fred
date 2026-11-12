import { describe, expect, it } from "vitest";
import { redactSecrets, secretValues } from "./redaction";

describe("secret redaction", () => {
  it("removes configured values and credential shapes while keeping the explanation", () => {
    const secrets = secretValues({ WORKER_SECRET: "worker-secret-value", GITLAB_TOKEN_CODEX: "opaque-codex-token", BOT_USER_ID_CODEX: "68", SHORT_KEY: "abc" });
    const text = [
      "fatal: unable to access 'https://oauth2:opaque-codex-token@gitlab.example/x.git/'",
      "PRIVATE-TOKEN: glpat-AAAAAAAAAAAAAAAAAAAA", "Authorization: Bearer sk-or-v1-0123456789abcdef0123",
      "admin key fred-pilot|0123456789abcdef0123456789abcdef01", "worker-secret-value", "password=hunter22",
      "Validator found 68 abc issues in global-configuration-variable-names",
    ].join("\n");
    const result = redactSecrets(text, secrets);
    expect(result).not.toMatch(/opaque-codex-token|glpat-|sk-or-|0123456789abcdef01|worker-secret-value|hunter22|oauth2/);
    expect(result).toContain("fatal: unable to access 'https://[redacted]@gitlab.example/x.git/'");
    expect(result).toContain("Validator found 68 abc issues in global-configuration-variable-names");
  });
});
