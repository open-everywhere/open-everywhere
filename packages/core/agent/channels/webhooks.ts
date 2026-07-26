import { defineChannel, POST, type RouteHandlerArgs } from "eve/channels";
import { getConfig } from "../access/config.js";
import { findWebhook, type WebhookHook } from "../webhooks/config.js";
import { gateWebhookDelivery, webhookMaxBodyBytes, type WebhookRejection } from "../webhooks/gate.js";
import { fireWebhook, webhookOrg } from "../webhooks/dispatch.js";
import { auditWebhookRejection } from "../webhooks/reject-audit.js";
import { appendAudit } from "../audit/audit.js";

function log(msg: string): void {
  console.log(`[open-everywhere:webhooks] ${msg}`);
}

async function auditRejection(id: string, hook: WebhookHook | undefined, rejection: WebhookRejection): Promise<void> {
  await auditWebhookRejection(id, hook, rejection);
}

async function deliver(hook: WebhookHook, body: string, receive: RouteHandlerArgs["receive"]): Promise<void> {
  const result = await fireWebhook(hook, body, { receive });
  const [, teamId, channelId] = hook.target.split("/");
  await appendAudit({
    org: webhookOrg(),
    platform: "slack",
    workspace: teamId,
    surface: channelId,
    principalId: `webhook:${hook.id}`,
    action: result.fired ? "webhook.fired" : "webhook.declined",
    detail: { hookId: hook.id, bytes: Buffer.byteLength(body, "utf8"), ...(result.reason ? { reason: result.reason } : {}) },
  });
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
      const secretValue = hook ? process.env[hook.secretEnv] : undefined;
      const rejection = gateWebhookDelivery({
        hook,
        secretValue,
        body,
        bodyBytes,
        signatureHeader: req.headers.get("x-hook-signature-256"),
        allowUnverified: process.env.OE_ALLOW_UNVERIFIED_WEBHOOK === "1",
        maxBodyBytes,
      });
      if (rejection) {
        log(`webhook "${id}" rejected (${rejection.status}): ${rejection.reason}`);
        waitUntil(auditRejection(id, hook, rejection));
        return new Response(rejection.reason, { status: rejection.status });
      }

      log(`webhook "${id}" accepted (${bodyBytes} bytes) — firing`);
      waitUntil(deliver(hook!, body, receive));
      return new Response("ok", { status: 200 });
    }),
  ],
});
