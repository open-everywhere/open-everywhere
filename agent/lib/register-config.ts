import { registerConfig } from "@open-everywhere/core/agent/access/config.js";
import { loadBundles, loadBindings } from "../access/bundles.js";
import { loadProviders } from "../access/providers.js";
import { PLUGIN_REGISTRY } from "../plugins/registry.js";
import { SKILL_CONTENT } from "../plugins/skill-content.js";
import { loadDomains, loadSilos, ORG_DEFAULT, domainsForSurface } from "../memory/domains.js";

registerConfig({
  loadBundles,
  loadBindings,
  loadProviders,
  pluginRegistry: PLUGIN_REGISTRY,
  skillContent: SKILL_CONTENT,
  loadDomains,
  loadSilos,
  orgDefault: ORG_DEFAULT,
  domainsForSurface,
});
