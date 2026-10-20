import type { AccessRequestsConfig } from "@open-everywhere/core/agent/access/config.js";
import { emptyAgentsFile } from "@open-everywhere/core/agent/memory/agents-codemod.js";
import { loadBaseBundles, loadBaseBindings } from "./bundles.js";
import { loadBaseConnectorCredentials } from "./connector-credentials.js";
import { loadBaseWebhooks } from "../webhooks/hooks.js";
import { MCP_SERVERS } from "./mcp-servers.js";
import { loadBaseDomains, loadBaseSilos, loadDomains } from "../memory/config/domains.js";
import { loadGroups } from "../identity/groups.js";
import { getSettings } from "@open-everywhere/core/agent/settings/settings.js";

export function loadAccessRequests(): AccessRequestsConfig | null {
  const { adminChannel, configRepo, configBase } = getSettings().accessRequests;
  return {
    adminChannel: adminChannel || undefined,
    configRepo: configRepo || undefined,
    configBase,
    dryRun: false,
    credentialBindingLive: false,
    baseBundles: loadBaseBundles,
    baseBindings: loadBaseBindings,
    domainRegistry: loadDomains,
    groupRegistry: loadGroups,
    baseConnectorCredentials: loadBaseConnectorCredentials,
    baseWebhooks: loadBaseWebhooks,
    baseMcpServers: () => MCP_SERVERS,
    baseAgents: emptyAgentsFile,
    baseDomains: loadBaseDomains,
    baseSilos: loadBaseSilos,
  };
}
