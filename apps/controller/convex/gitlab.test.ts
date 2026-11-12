import { describe, expect, it } from "vitest";
import botAuthor from "../../../fixtures/webhooks/bot-author.json";
import commentOnly from "../../../fixtures/webhooks/comment-only.json";
import pushWhileAssigned from "../../../fixtures/webhooks/push-while-assigned.json";
import reRequested from "../../../fixtures/webhooks/re-requested.json";
import reviewerAdded from "../../../fixtures/webhooks/reviewer-added.json";
import reviewerAddedGitlab18 from "../../../fixtures/webhooks/reviewer-added-gitlab-18.0.json";
import { detectTrigger, parseWebhook } from "./gitlab";

// 901 is this project's FRED bot, 801 another project's FRED bot, and 300 a bot outside FRED.
const botId = "901";
const botAuthorIds = ["801", "300"];

function triggerOf(body: unknown) {
  const parsed = parseWebhook(body);
  if (parsed.kind !== "merge_request") throw new Error(`fixture did not parse: ${JSON.stringify(parsed)}`);
  return detectTrigger(parsed.event, botId, botAuthorIds);
}

describe("parseWebhook", () => {
  it("ignores other event kinds and rejects malformed merge_request bodies", () => {
    expect(parseWebhook({ object_kind: "push" })).toEqual({ kind: "other" });
    expect(parseWebhook("nonsense")).toEqual({ kind: "other" });
    expect(parseWebhook({ object_kind: "merge_request", user: { id: 1 } })).toMatchObject({ kind: "invalid" });
  });
});

describe("detectTrigger", () => {
  it("captures the budget owner's name without using another actor's name", () => {
    const event = { ...reviewerAdded, user: { ...reviewerAdded.user, name: "Daniel Kistner" },
      changes: { reviewers: { previous: [], current: [{ id: 901, username: "project_7_bot_fred" }, { id: 902, username: "codex" }] } } };
    expect(triggerOf(event)).toMatchObject({ provider: "fred", budgetOwner: { gitlabUserId: "42", username: "daniel", displayName: "Daniel Kistner" } });
    expect(triggerOf({ ...event, user: { id: 99, username: "other", name: "Another Reviewer" } })?.budgetOwner).toEqual({ gitlabUserId: "42" });
  });

  it("reviewer added requests one FRED review at the head sha", () => {
    expect(triggerOf(reviewerAdded)).toEqual(
      {
        provider: "fred",
        kind: "reviewer_added",
        headSha: "e59094b8de0f2f91abbe4760a52d9137260252d8",
        mrIid: 16,
        project: { gitlabProjectId: "7", path: "frei/flight-management" },
        triggeredBy: "42",
        budgetOwner: { gitlabUserId: "42", username: "daniel", displayName: "Daniel Kistner" },
      },
    );
  });

  it("parses the GitLab 18.0 previous/current shape of changes.reviewers", () => {
    const parsed = parseWebhook(reviewerAddedGitlab18);
    if (parsed.kind !== "merge_request") throw new Error("did not parse");
    expect(detectTrigger(parsed.event, "62")).toEqual(
      {
        provider: "fred",
        kind: "reviewer_added",
        headSha: "bcf13b86ef4ddf3e97c0eb9aa976a1fcb45f2348",
        mrIid: 737,
        project: { gitlabProjectId: "9", path: "acme/app" },
        triggeredBy: "31",
        budgetOwner: { gitlabUserId: "31", username: "daniel", displayName: "Daniel Kistner" },
      },
    );
  });

  it("re-requested review requests one FRED review", () => {
    expect(triggerOf(reRequested)).toMatchObject({ provider: "fred", kind: "re_requested" });
  });

  it("push while the bot is assigned requests a review at the new sha", () => {
    expect(triggerOf(pushWhileAssigned)).toMatchObject({ provider: "fred", kind: "push", headSha: "aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00" });
  });

  it("a comment-only update is ignored", () => {
    expect(triggerOf(commentOnly)).toBeUndefined();
  });

  it("bot-authored MR charges the user who added the reviewer", () => {
    expect(triggerOf(botAuthor)).toMatchObject(
      { provider: "fred", kind: "reviewer_added", triggeredBy: "42", budgetOwner: { gitlabUserId: "42", username: "daniel", displayName: "Daniel Kistner" } },
    );
  });

  it("a push on a bot-authored MR is ignored", () => {
    const push = {
      ...botAuthor,
      object_attributes: { ...botAuthor.object_attributes, oldrev: "e59094b8de0f2f91abbe4760a52d9137260252d8" },
      changes: {},
    };
    expect(triggerOf(push)).toBeUndefined();
  });

  it.each([
    { ids: [901], requested: true },
    { ids: [902, 901], requested: true },
    { ids: [902], requested: false },
    { ids: [55], requested: false },
    { ids: [], requested: false },
  ])("creation with reviewers $ids requests a review: $requested, without a change delta", ({ ids, requested }) => {
    const opened = {
      ...reviewerAdded,
      object_attributes: { ...reviewerAdded.object_attributes, action: "open", draft: true },
      changes: undefined,
      reviewers: ids.map((id) => ({ id, username: String(id) })),
    };
    expect(triggerOf(opened)).toEqual(requested ? {
      provider: "fred",
      kind: "mr_opened",
      headSha: reviewerAdded.object_attributes.last_commit.id,
      mrIid: 16,
      project: { gitlabProjectId: "7", path: "frei/flight-management" },
      triggeredBy: "42",
      budgetOwner: { gitlabUserId: "42", username: "daniel", displayName: "Daniel Kistner" },
    } : undefined);
  });

  it("creation uses assigned reviewers even when a reviewer change delta is present", () => {
    const opened = { ...reviewerAdded, object_attributes: { ...reviewerAdded.object_attributes, action: "open" } };
    expect(triggerOf(opened)).toMatchObject({ provider: "fred", kind: "mr_opened" });
    expect(triggerOf({ ...opened, reviewers: undefined })).toBeUndefined();
  });

  it.each([300, 801, 901])("creation by bot %s does not request reviews", (author_id) => {
    const opened = {
      ...pushWhileAssigned,
      user: { id: author_id, username: "automation-bot" },
      object_attributes: { ...pushWhileAssigned.object_attributes, action: "open", oldrev: null, author_id },
      changes: {},
    };
    expect(triggerOf(opened)).toBeUndefined();
  });

  it.each(["reopen", "close", "merge", "approved", undefined])("action %s does not request a review", (action) => {
    expect(triggerOf({ ...reviewerAdded, object_attributes: { ...reviewerAdded.object_attributes, action } })).toBeUndefined();
  });
});
