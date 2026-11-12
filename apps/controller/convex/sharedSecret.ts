// True when `candidate` equals the configured secret `expected`; an unset or empty secret matches nothing. Compares every
// character, so the response time does not reveal how long the matching prefix is.
export function matchesSecret(candidate: string, expected: string | undefined) {
  if (!expected) return false;
  let difference = candidate.length ^ expected.length;
  for (let index = 0; index < Math.max(candidate.length, expected.length); index++) {
    difference |= candidate.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}
