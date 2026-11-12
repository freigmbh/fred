export const failureDetailLimit = 2000;

const secretName = /SECRET|TOKEN|KEY|PASSWORD|CREDENTIAL/i;
const redacted = "[redacted]";
const credentialShapes: [RegExp, string][] = [
  [/\bgl(?:pat|oas|dt|rt|cbt|ptt|ft|soat|agent)-[A-Za-z0-9_-]{16,}/g, redacted],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, redacted],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, redacted],
  [/\b[\w-]+\|[0-9a-f]{32,}/g, redacted],
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+(?::[^\s/@]*)?@/gi, `$1${redacted}@`],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${redacted}`],
  [/\b(private-token|authorization|x-api-key|api[_-]?key|access[_-]?token|password|secret)(["']?\s*[:=]\s*["']?)(?!\[redacted\])[^\s"',;]+/gi, `$1$2${redacted}`],
];

// The values redactSecrets replaces: secret-named variables of `env` plus `known` secrets such as a claimed token, longest first.
// Values shorter than 8 characters are skipped.
export function secretValues(env: Record<string, string | undefined>, known: readonly string[] = []) {
  return [...Object.entries(env).flatMap(([name, value]) => value && secretName.test(name) ? [value] : []), ...known]
    .filter((value) => value.length >= 8)
    .sort((a, b) => b.length - a.length);
}

export function redactSecrets(text: string, secrets: readonly string[] = []) {
  let result = text;
  for (const secret of secrets) result = result.replaceAll(secret, redacted);
  for (const [pattern, replacement] of credentialShapes) result = result.replace(pattern, replacement);
  return result;
}
