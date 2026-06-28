import { registerConfig } from "@open-everywhere/core/agent/access/config.js";
import { loadBundles, loadBindings } from "../access/bundles.js";
import { PLUGIN_REGISTRY } from "../plugins/registry.js";
import { SKILL_CONTENT } from "../plugins/skill-content.js";
import { domainsForSurface } from "../memory/domains.js";

registerConfig({
  loadBundles,
  loadBindings,
  pluginRegistry: PLUGIN_REGISTRY,
  skillContent: SKILL_CONTENT,
  domainsForSurface,
});
