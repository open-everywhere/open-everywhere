import { defineChannel, POST, type RouteHandlerArgs } from "eve/channels";
import { getConfig } from "../access/config.js";
import { configHookDisclosure, configHookPosture, findWebhook, isFusedHook, type WebhookHook } from "../webhooks/config.js";
import { acceptedUnverified, gateWebhookDelivery, webhookMaxBodyBytes, type GateableHook, type WebhookRejection } from "../webhooks/gate.js";
import "../webhooks/oe-standard-webhook.js";
import { resolveHookKeys } from "../webhooks/secrets.js";
import { admitTrigger } from "../routines/ingress.js";
import { declaredDeliveryId } from "../routines/event-model.js";
import { fireWebhook, webhookOrg } from "../webhooks/dispatch.js";
import { auditWebhookRejection } from "../webhooks/reject-audit.js";
import { firstSightingOfWebhookDelivery, REPLAYED_DELIVERY_AUDIT_REASON, REPLAYED_DELIVERY_CALLER_BODY } from "../webhooks/replay-dedupe.js";
import { appendAudit } from "../audit/audit.js";

function log(msg: string): void {
  console.log(`[open-everywhere:webhooks] ${msg}`);
}

async function auditRejection(id: string, hook: WebhookHook | { readonly id: string } | undefined, rejection: WebhookRejection): Promise<void> {
  await auditWebhookRejection(id, hook, rejection);
}

async function deliver(hook: WebhookHook, body: string, headers: Headers, receive: RouteHandlerArgs["receive"], keyIndex: number | null): Promise<void> {
  const flat = lowercaseHeaders(headers);
  const result = isFusedHook(hook) ? await fireWebhook(hook, body, { receive, headers: flat }) : undefined;
  const emitted = await emitConfigHookEvent(hook, body, flat, receive);
  const [, teamId, channelId] = hook.target?.split("/") ?? [];
  const previousKey = keyIndex !== null && keyIndex > 0;
  const unverified = acceptedUnverified({ ok: true, keyIndex });
  const fired = result ? result.fired : (emitted?.accepted ?? false);
  await appendAudit({
    org: webhookOrg(),
    platform: teamId ? "slack" : "webhook",
    workspace: teamId ?? "-",
    surface: channelId ?? "-",
    principalId: `webhook:${hook.id}`,
    action: fired ? "webhook.fired" : "webhook.declined",
    detail: {
      hookId: hook.id,
      source: hook.source,
      posture: configHookPosture(hook),
      bytes: Buffer.byteLength(body, "utf8"),
      ...(previousKey ? { keyIndex, previousKey: true } : {}),
      ...(unverified ? { unverified: true } : {}),
      ...(result?.reason ? { reason: result.reason } : {}),
      ...(emitted ? { matched: emitted.matched, fired: emitted.fired, skipped: emitted.skipped } : {}),
      ...(emitted?.deliveryId ? { deliveryId: emitted.deliveryId } : {}),
      ...(emitted && !emitted.accepted && emitted.reason ? { routingReason: emitted.reason } : {}),
    },
  });
  if (previousKey) log(`WARN "${hook.id}": verified against a PREVIOUS key (secretRef index ${keyIndex}) — a sender has not moved to the current key yet`);
  if (unverified)
    log(`WARN "${hook.id}": accepted UNVERIFIED (OE_ALLOW_UNVERIFIED_WEBHOOK=1, no resolvable secret) — nothing authenticated this sender but the URL`);
  log(
    `"${hook.id}" (${configHookPosture(hook)}): ${result ? (result.fired ? "fired" : `declined (${result.reason})`) : "emit-only"}` +
      `${emitted ? `; routines matched ${emitted.matched}, fired ${emitted.fired}` : ""}`,
  );
}

function lowercaseHeaders(headers: Headers): Record<string, string> {
  const flat: Record<string, string> = {};
  headers.forEach((v, k) => {
    flat[k.toLowerCase()] = v;
  });
  return flat;
}

async function emitConfigHookEvent(
  hook: WebhookHook,
  body: string,
  flat: Readonly<Record<string, string>>,
  receive: RouteHandlerArgs["receive"],
): Promise<{ matched: number; fired: number; skipped: number; accepted: boolean; reason?: string; deliveryId?: string } | undefined> {
  const deliveryId = declaredDeliveryId(hook.source, flat);
  try {
    const report = await admitTrigger(
      {
        source: hook.id,
        scheme: hook.source,
        headers: flat,
        body,
        ...(deliveryId ? { deliveryId } : {}),
        receivedAt: new Date().toISOString(),
        readableBy: hook.readableBy,
        ...configHookDisclosure(hook),
      },
      { receive, org: webhookOrg() },
    );
    return {
      matched: report.matched,
      fired: report.fired,
      skipped: report.skipped,
      accepted: report.accepted,
      ...(report.reason ? { reason: report.reason } : {}),
      ...(report.deliveryId ? { deliveryId: report.deliveryId } : {}),
    };
  } catch (err) {
    log(`WARN "${hook.id}": event fan-out failed — ${String(err instanceof Error ? err.message : err)}`);
    return undefined;
  }
}

export default defineChannel({
  routes: [
    POST("/webhooks/:id", async (req, { receive, waitUntil, params }) => {
      const id = params["id"] ?? "";
      const hooks = getConfig().loadWebhooks?.() ?? [];
      const hook = findWebhook(hooks, id);
      const gated: GateableHook | undefined = hook;
      const maxBodyBytes = webhookMaxBodyBytes();

      const declaredLen = Number(req.headers.get("content-length") ?? NaN);
      if (Number.isFinite(declaredLen) && declaredLen > maxBodyBytes) {
        const rejection: WebhookRejection = { status: 413, reason: `payload exceeds ${maxBodyBytes} bytes` };
        log(`webhook "${id}" rejected (413): ${rejection.reason} (Content-Length)`);
        waitUntil(auditRejection(id, gated, rejection));
        return new Response(rejection.reason, { status: rejection.status });
      }

      const body = await req.text();
      const bodyBytes = Buffer.byteLength(body, "utf8");

      const secretValues = hook ? await resolveHookKeys(hook) : [];
      const outcome = await gateWebhookDelivery({
        hook: gated,
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
        waitUntil(auditRejection(id, gated, rejection));
        return new Response(rejection.reason, { status: rejection.status });
      }

      if (outcome.replayKey) {
        const firstSeen = await firstSightingOfWebhookDelivery(webhookOrg(), id, outcome.replayKey);
        if (!firstSeen) {
          const rejection: WebhookRejection = { status: 409, reason: REPLAYED_DELIVERY_AUDIT_REASON };
          log(`webhook "${id}" rejected (409): ${rejection.reason}`);
          waitUntil(auditRejection(id, gated, rejection));
          return new Response(REPLAYED_DELIVERY_CALLER_BODY, { status: rejection.status });
        }
      }

      log(`webhook "${id}" accepted (${bodyBytes} bytes) — firing`);
      waitUntil(deliver(hook!, body, req.headers, receive, outcome.keyIndex));
      return new Response("ok", { status: 200 });
    }),
  ],
});
