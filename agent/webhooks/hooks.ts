import { defineWebhook, assertWebhooksValid, type WebhookHook } from "@open-everywhere/core/agent/webhooks/config.js";

const hooks: WebhookHook[] = [
  defineWebhook({
    id: "smoke-test",
    secretEnv: "OE_WEBHOOK_SMOKE_SECRET",
    target: "slack/T0EXAMPLE/C0EXGENRL",
    instruction:
      "This is the deployment's smoke-test webhook. Post one short line confirming the " +
      "webhook fired and quote the payload's `note` field verbatim if present.",
  }),
];

assertWebhooksValid(hooks);

export function loadWebhooks(): readonly WebhookHook[] {
  return hooks;
}
