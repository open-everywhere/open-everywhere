import { defineWebhook, assertWebhooksValid, type WebhookHook } from "@open-everywhere/core/agent/webhooks/config.js";

const hooks: WebhookHook[] = [
];

assertWebhooksValid(hooks);

export function loadWebhooks(): readonly WebhookHook[] {
  return hooks;
}
