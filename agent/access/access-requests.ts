import type { AccessRequestsConfig } from "@open-everywhere/core/agent/access/config.js";
import { loadBaseBundles, loadBaseBindings } from "./bundles.js";
import { loadBaseProviders } from "./providers.js";
import { loadBaseWebhooks } from "../webhooks/hooks.js";

export function loadAccessRequests(): AccessRequestsConfig | null {
  return {
    adminChannel: process.env.OE_ACCESS_ADMIN_CHANNEL,
    configRepo: process.env.OE_ACCESS_CONFIG_REPO,
    configBase: process.env.OE_ACCESS_CONFIG_BASE || undefined,
    grantsPath: process.env.OE_ACCESS_GRANTS_PATH || undefined,
    dryRun: process.env.OE_ACCESS_DRY_RUN === "1",
    baseBundles: loadBaseBundles,
    baseBindings: loadBaseBindings,
    baseProviders: loadBaseProviders,
    hooksPath: process.env.OE_WEBHOOK_HOOKS_PATH || undefined,
    baseWebhooks: loadBaseWebhooks,
  };
}
