import { defineWebhook, assertWebhooksValid, type WebhookHook } from "@open-everywhere/core/agent/webhooks/config.js";
import { loadHooksOverlay } from "./hooks-overlay.js";
import { loadDomains } from "../memory/config/domains.js";

const hooks: WebhookHook[] = [
];

const merged: WebhookHook[] = [...hooks, ...loadHooksOverlay().hooks];

assertWebhooksValid(merged, { domains: loadDomains() });

export function loadWebhooks(): readonly WebhookHook[] {
  return merged;
}

export function loadBaseWebhooks(): readonly WebhookHook[] {
  return hooks;
}
