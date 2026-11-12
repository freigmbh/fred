import { expect, it } from "vitest";
import { parseFindingCommandEvent } from "./findingCommandWebhook";

const body = {
  object_kind: "note",
  project: { id: 7, path_with_namespace: "team/repo" },
  user: { id: 42 },
  object_attributes: {
    id: 123,
    note: "fred dismiss finding-1 This behavior is intentional.",
    noteable_type: "MergeRequest",
    action: "create",
    system: false,
    author_id: 42,
  },
  merge_request: { iid: 16 },
};
it.each(["dismiss", "undo"])("parses an explicit %s command and trims the reason", (action) => {
  const note = `fred ${action} finding-1  The requirement changed.  `;
  expect(parseFindingCommandEvent({ ...body, object_attributes: { ...body.object_attributes, note } })).toEqual({
    action, reference: "finding-1", reason: "The requirement changed.", body: note,
    gitlabProjectId: "7", mrIid: 16, noteId: "123", actorId: "42",
  });
});

it.each([
  ["dismiss", "job123/0"],
  ["undo", "command:command123"],
])("accepts the published %s reference %s", (action, reference) => {
  const note = `fred ${action} ${reference} The requirement changed.`;
  expect(parseFindingCommandEvent({ ...body, object_attributes: { ...body.object_attributes, note } })).toMatchObject({ action, reference });
});

it.each([
  "fred dismiss finding-1",
  "fred dismiss finding-1   ",
  `fred dismiss finding-1 ${"a".repeat(2_001)}`,
  "Fred dismiss finding-1 Reason",
  "fred resolve finding-1 Reason",
  "fred dismiss ../finding Reason",
  "fred dismiss <finding-1> Reason",
  " fred dismiss finding-1 Reason",
  "> fred dismiss finding-1 Reason",
  "`fred dismiss finding-1 Reason`",
  "```\nfred dismiss finding-1 Reason\n```",
  "Try this: fred dismiss finding-1 Reason",
  "fred dismiss finding-1 Reason\nAdditional prose",
  "fred dismiss finding-1 Reason\r",
  "fred dismiss finding-1 Reason\u2028Another line",
])("ignores malformed, quoted, or multiline commands: %s", (note) => {
  expect(parseFindingCommandEvent({ ...body, object_attributes: { ...body.object_attributes, note } })).toBeUndefined();
});

it.each([
  { object_kind: "merge_request" },
  { object_attributes: { ...body.object_attributes, action: "update" } },
  { object_attributes: { ...body.object_attributes, action: undefined } },
  { object_attributes: { ...body.object_attributes, noteable_type: "Issue" } },
  { object_attributes: { ...body.object_attributes, system: true } },
  { object_attributes: { ...body.object_attributes, author_id: 43 } },
  { user: { id: 42, bot: true } },
  { project: { id: 7.5, path_with_namespace: "team/repo" } },
])("ignores events that cannot be a new human MR command: %j", (override) => {
  expect(parseFindingCommandEvent({ ...body, ...override })).toBeUndefined();
});
