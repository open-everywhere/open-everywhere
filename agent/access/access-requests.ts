import type { AccessRequestsConfig } from "@open-everywhere/core/agent/access/config.js";
import { emptyAgentsFile } from "@open-everywhere/core/agent/memory/agents-codemod.js";
import { loadBaseBundles, loadBaseBindings } from "./bundles.js";
import { loadBaseConnectorCredentials } from "./connector-credentials.js";
import { loadBaseWebhooks } from "../webhooks/hooks.js";
import { loadBaseDomains, loadBaseSilos } from "../memory/config/domains.js";
import { loadGroups } from "../identity/groups.js";

export function loadAccessRequests(): AccessRequestsConfig | null {
  return {
    adminChannel: process.env.OE_ACCESS_ADMIN_CHANNEL,
    configRepo: process.env.OE_ACCESS_CONFIG_REPO,
    configBase: process.env.OE_ACCESS_CONFIG_BASE || undefined,
    grantsPath: process.env.OE_ACCESS_GRANTS_PATH || undefined,
    dryRun: process.env.OE_ACCESS_DRY_RUN === "1",
    baseBundles: loadBaseBundles,
    baseBindings: loadBaseBindings,
    groupRegistry: loadGroups,
    baseConnectorCredentials: loadBaseConnectorCredentials,
    hooksPath: process.env.OE_WEBHOOK_HOOKS_PATH || undefined,
    baseWebhooks: loadBaseWebhooks,
    agentsPath: process.env.OE_AGENTS_PATH || undefined,
    baseAgents: emptyAgentsFile,
    baseDomains: loadBaseDomains,
    baseSilos: loadBaseSilos,
  };
}
