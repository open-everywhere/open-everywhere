import { defineWebhook, assertWebhooksValid, type WebhookHook } from "@open-everywhere/core/agent/webhooks/config.js";

const hooks: WebhookHook[] = [
  defineWebhook({
    id: "smoke-test",
    source: "oe-hmac",
    secretRef: "OE_WEBHOOK_SMOKE_SECRET",
    broker: "env",
    target: "slack/T0EXAMPLE/C0EXCHAN003",
    instruction:
      "This is the deployment's smoke-test webhook. Post one short line confirming the " +
      "webhook fired and quote the payload's `note` field verbatim if present.",
  }),
  defineWebhook({
    id: "e2e-smoke",
    source: "oe-hmac",
    secretRef: "OE_WEBHOOK_E2E_SECRET",
    broker: "env",
    target: "slack/T0EXAMPLE/C0EXCHAN003",
    instruction:
      "This is the e2e driver-bot pack's own smoke-test webhook. ALWAYS post one short line " +
      "confirming the webhook fired and quote the payload's `note` field verbatim — never stay " +
      "silent for this hook, even if nothing else about the payload looks actionable.",
  }),
];

assertWebhooksValid(hooks);

export function loadWebhooks(): readonly WebhookHook[] {
  return hooks;
}
