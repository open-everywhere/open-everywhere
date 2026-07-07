import { registerConfig } from "@open-everywhere/core/agent/access/config.js";
import { loadBundles, loadBindings } from "../access/bundles.js";
import { loadProviders } from "../access/providers.js";
import { loadAccessRequests } from "../access/access-requests.js";
import { PLUGIN_REGISTRY } from "../plugins/registry.js";
import { SKILL_CONTENT } from "../plugins/skill-content.js";
import { loadDomains, loadSilos, domainsForSurface } from "../memory/domains.js";
import { loadRoles } from "../roles/roles.js";
import { loadWebhooks } from "../webhooks/hooks.js";
import { loadSpendBudgets } from "../spend/budgets.js";
import "../identity/trusted-surfaces.js";

registerConfig({
  loadBundles,
  loadBindings,
  loadProviders,
  pluginRegistry: PLUGIN_REGISTRY,
  skillContent: SKILL_CONTENT,
  loadDomains,
  loadSilos,
  loadRoles,
  domainsForSurface,
  loadWebhooks,
  loadSpendBudgets,
  loadAccessRequests,
});
