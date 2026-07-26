import { defineChannel, POST, type RouteHandlerArgs } from "eve/channels";
import { getConfig } from "../access/config.js";
import { findWebhook, type WebhookHook } from "../webhooks/config.js";
import { gateWebhookDelivery, webhookMaxBodyBytes, type WebhookRejection } from "../webhooks/gate.js";
import "../webhooks/oe-hmac.js";
import { resolveHookKeys } from "../webhooks/secrets.js";
import { fireWebhook, webhookOrg } from "../webhooks/dispatch.js";
import { auditWebhookRejection } from "../webhooks/reject-audit.js";
import { firstSightingOfWebhookDelivery } from "../webhooks/replay-dedupe.js";
import { appendAudit } from "../audit/audit.js";

function log(msg: string): void {
  console.log(`[open-everywhere:webhooks] ${msg}`);
}

async function auditRejection(id: string, hook: WebhookHook | undefined, rejection: WebhookRejection): Promise<void> {
  await auditWebhookRejection(id, hook, rejection);
}

async function deliver(hook: WebhookHook, body: string, receive: RouteHandlerArgs["receive"], keyIndex: number | null): Promise<void> {
  const result = await fireWebhook(hook, body, { receive });
  const [, teamId, channelId] = hook.target.split("/");
  const previousKey = keyIndex !== null && keyIndex > 0;
  await appendAudit({
    org: webhookOrg(),
    platform: "slack",
    workspace: teamId,
    surface: channelId,
    principalId: `webhook:${hook.id}`,
    action: result.fired ? "webhook.fired" : "webhook.declined",
    detail: {
      hookId: hook.id,
      source: hook.source,
      bytes: Buffer.byteLength(body, "utf8"),
      ...(previousKey ? { keyIndex, previousKey: true } : {}),
      ...(result.reason ? { reason: result.reason } : {}),
    },
  });
  if (previousKey) log(`WARN "${hook.id}": verified against a PREVIOUS key (secretRef index ${keyIndex}) — a sender has not moved to the current key yet`);
  log(`"${hook.id}": ${result.fired ? "fired" : `declined (${result.reason})`}`);
}

export default defineChannel({
  routes: [
    POST("/webhooks/:id", async (req, { receive, waitUntil, params }) => {
      const id = params["id"] ?? "";
      const hooks = getConfig().loadWebhooks?.() ?? [];
      const hook = findWebhook(hooks, id);
      const maxBodyBytes = webhookMaxBodyBytes();

      const declaredLen = Number(req.headers.get("content-length") ?? NaN);
      if (Number.isFinite(declaredLen) && declaredLen > maxBodyBytes) {
        const rejection: WebhookRejection = { status: 413, reason: `payload exceeds ${maxBodyBytes} bytes` };
        log(`webhook "${id}" rejected (413): ${rejection.reason} (Content-Length)`);
        waitUntil(auditRejection(id, hook, rejection));
        return new Response(rejection.reason, { status: rejection.status });
      }

      const body = await req.text();
      const bodyBytes = Buffer.byteLength(body, "utf8");
      const secretValues = hook ? await resolveHookKeys(hook) : [];
      const outcome = await gateWebhookDelivery({
        hook,
        secretValues,
        rawBody: body,
        bodyBytes,
        headers: req.headers,
        nowMs: Date.now(),
        allowUnverified: process.env.OE_ALLOW_UNVERIFIED_WEBHOOK === "1",
        maxBodyBytes,
      });
      if (!outcome.ok) {
        const { rejection } = outcome;
        log(`webhook "${id}" rejected (${rejection.status}): ${rejection.reason}`);
        waitUntil(auditRejection(id, hook, rejection));
        return new Response(rejection.reason, { status: rejection.status });
      }

      if (outcome.replayKey) {
        const firstSeen = await firstSightingOfWebhookDelivery(webhookOrg(), id, outcome.replayKey);
        if (!firstSeen) {
          const rejection: WebhookRejection = {
            status: 409,
            reason: "duplicate delivery rejected — an already-accepted delivery was replayed inside its skew window",
          };
          log(`webhook "${id}" rejected (409): ${rejection.reason}`);
          waitUntil(auditRejection(id, hook, rejection));
          return new Response(rejection.reason, { status: rejection.status });
        }
      }

      log(`webhook "${id}" accepted (${bodyBytes} bytes) — firing`);
      waitUntil(deliver(hook!, body, receive, outcome.keyIndex));
      return new Response("ok", { status: 200 });
    }),
  ],
});
