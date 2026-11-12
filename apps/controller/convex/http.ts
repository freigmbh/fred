import type { DiagnosticEvent } from "@fred/contracts";
import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction, type ActionCtx } from "./_generated/server";
import { handleFindingCommand } from "./findingCommandWebhook";
import { detectTrigger, parseWebhook } from "./gitlab";
import { matchesSecret } from "./sharedSecret";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// Identifies a delivery without headers by its body so an exact replay stays idempotent.
async function payloadKey(body: unknown) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(body)));
  return `payload:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function recordWebhook(ctx: ActionCtx, event: Omit<DiagnosticEvent, "phase" | "at">, identity?: { gitlabProjectId: string; projectPath: string; mrIid: number }) {
  try {
    await ctx.runMutation(internal.diagnostics.webhook, { ...identity, eventJson: JSON.stringify({ ...event, phase: "webhook", at: Date.now() }) });
  } catch { console.warn("FRED webhook diagnostic recording failed"); }
}

const gitlabWebhook = httpAction(async (ctx, request) => {
  if (!matchesSecret(request.headers.get("X-Gitlab-Token") ?? "", process.env.GITLAB_WEBHOOK_SECRET)) {
    await recordWebhook(ctx, { kind: "webhook_unauthorized", reason: "unauthorized" });
    return json({ error: "unauthorized" }, 401);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    await recordWebhook(ctx, { kind: "webhook_invalid", reason: "invalid_payload" });
    return json({ error: "body is not JSON" }, 400);
  }

  const command = await handleFindingCommand(ctx, body);
  if (command) return command;
  const parsed = parseWebhook(body);
  if (parsed.kind === "other") {
    await recordWebhook(ctx, { kind: "webhook_ignored", reason: "unsupported_event" });
    return json({ ignored: true });
  }
  if (parsed.kind === "invalid") {
    await recordWebhook(ctx, { kind: "webhook_invalid", reason: "invalid_payload" });
    return json({ error: parsed.reason }, 400);
  }
  const identity = { gitlabProjectId: String(parsed.event.project.id), projectPath: parsed.event.project.path_with_namespace, mrIid: parsed.event.object_attributes.iid };
  await recordWebhook(ctx, { kind: "webhook_received" }, identity);

  try {
    const bot = await ctx.runQuery(internal.projectTokens.identity, { gitlabProjectId: identity.gitlabProjectId });
    if (bot.botUserId === null) {
      await recordWebhook(ctx, { kind: "webhook_ignored", reason: "unconfigured" }, identity);
      return json({ ignored: true, reason: "project not connected to FRED" });
    }
    const trigger = detectTrigger(parsed.event, bot.botUserId, bot.botAuthorIds);
    if (!trigger) {
      await recordWebhook(ctx, { kind: "webhook_ignored", reason: "no_trigger" }, identity);
      return json({ ignored: true });
    }

    const deliveryKey = request.headers.get("webhook-id") ?? request.headers.get("Idempotency-Key") ?? await payloadKey(body);
    const outcome = await ctx.runMutation(internal.enqueue.enqueue, { ...trigger, deliveryKey });
    return json({ provider: trigger.provider, kind: trigger.kind, ...outcome });
  } catch (error) {
    await recordWebhook(ctx, { kind: "failed", failure: { category: "controller" } }, identity);
    throw error;
  }
});

const http = httpRouter();
http.route({ path: "/webhook/gitlab", method: "POST", handler: gitlabWebhook });
export default http;
