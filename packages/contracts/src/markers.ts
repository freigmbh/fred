// The words FRED writes into GitLab and later reads back: review labels, publication keys, and hidden note markers.
// The worker publishes with them, the controller creates the labels and delivers its own notes with them.

export const reviewLabelPrefix = "fred-review::";
export const reviewLabels = { clean: `${reviewLabelPrefix}clean`, findings: `${reviewLabelPrefix}findings` } as const;
export type ReviewVerdict = keyof typeof reviewLabels;

// The verdict of a stored label effect. Results of the retired claude- and codex- bots carry their own prefixes.
export const labelVerdict = (label: string): ReviewVerdict => label.endsWith("::clean") ? "clean" : "findings";

// Keys of a review result's publication effects, unique within one result and acknowledged one by one.
export const effectKeys = {
  summary: "summary",
  finding: (findingIndex: number) => `finding:${findingIndex}`,
  resolve: (findingId: string) => `resolve:${findingId}`,
  label: "label",
} as const;

// Marker keys identify one write across retries: an effect of a review job, or the decision reply of a finding command.
export const markerKey = (ownerId: string, effectKey: string) => `${ownerId}:${effectKey}`;
export const summaryMarkerKey = (jobId: string) => markerKey(jobId, effectKeys.summary);
export const commandDecisionMarkerKey = (commandId: string) => markerKey(commandId, "decision");

// The reference of a validator decision on an earlier finding: shown in the summary, accepted by `fred undo`,
// and stored as the decision's event key.
export const decisionReference = (jobId: string, findingId: string) => `${jobId}:decision:${findingId}`;

// Every hidden marker FRED appends starts with this prefix, so prompts can leave FRED's own notes out.
export const fredMarkerPrefix = "<!-- fred-";
export const publicationMarkerPrefix = `${fredMarkerPrefix}review:`;

const base64urlAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

// Unpadded base64url of the UTF-8 bytes of `text`, without runtime-specific globals so Convex and Node agree.
const base64url = (text: string) => {
  const bytes = [...encodeURIComponent(text).matchAll(/%([0-9A-F]{2})|[^%]/g)].map(([character, hex]) => hex ? Number.parseInt(hex, 16) : character.charCodeAt(0));
  let encoded = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const [first = 0, second, third] = bytes.slice(index, index + 3);
    const chunk = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    const sextets = [18, 12, 6, 0].map((shift) => base64urlAlphabet[(chunk >> shift) & 63]);
    encoded += sextets.slice(0, second === undefined ? 2 : third === undefined ? 3 : 4).join("");
  }
  return encoded;
};

// The hidden marker the worker appends to a published note. The key is base64url-encoded so repository text cannot forge it.
export const publicationMarker = (key: string) => `${publicationMarkerPrefix}${base64url(key)} -->`;

// The hidden marker the controller appends to a delivered MR note, keyed by its `mrNotes` ID.
export const noteMarker = (noteId: string) => `${fredMarkerPrefix}note:${noteId} -->`;

// The opening words of the comment the controller posts for a failed review.
export const reviewFailureHeading = "AI review failed";
