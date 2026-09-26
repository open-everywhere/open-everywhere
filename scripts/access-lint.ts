import { domainContainers } from "@open-everywhere/core/agent/memory/domain.js";
import { lintAccessConfig } from "@open-everywhere/core/agent/access/lint.js";
import { importAppModule, resolveAppRoot } from "@open-everywhere/core/agent/scaffold/app-root.js";

const APP_ROOT = resolveAppRoot();
const { loadBundles, loadBindings } = await importAppModule<typeof import("../agent/access/bundles.js")>("agent/access/bundles.ts", APP_ROOT);
const { loadDomains } = await importAppModule<typeof import("../agent/memory/config/domains.js")>("agent/memory/config/domains.ts", APP_ROOT);
const { loadGroups } = await importAppModule<typeof import("../agent/identity/groups.js")>("agent/identity/groups.ts", APP_ROOT);
const { loadConnectorCredentials } = await importAppModule<typeof import("../agent/access/connector-credentials.js")>("agent/access/connector-credentials.ts", APP_ROOT);
const { PLUGIN_REGISTRY } = await importAppModule<typeof import("../agent/plugins/registry.js")>("agent/plugins/registry.ts", APP_ROOT);

const problems = lintAccessConfig(
  loadBundles(),
  loadBindings(),
  loadDomains(),
  loadGroups(),
  PLUGIN_REGISTRY,
  loadConnectorCredentials(),
);

if (problems.length > 0) {
  console.error(`✗ access-lint: ${problems.length} problem(s):\n` + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}
const claiming = loadDomains().filter((d) => domainContainers(d).length > 0).length;
console.log(
  `✓ access-lint: broad-grant + method-narrowing + domain-capability lints clean (${loadBundles().length} bundle(s), ${loadBindings().length} binding(s), ${loadDomains().length} domain(s) of which ${claiming} reach a container, ${loadGroups().length} person-group(s))`,
);
