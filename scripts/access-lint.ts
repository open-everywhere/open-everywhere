import { loadBundles, loadBindings } from "../agent/access/bundles.js";
import { loadDomains } from "../agent/memory/config/domains.js";
import { domainContainers } from "@open-everywhere/core/agent/memory/domain.js";
import { loadGroups } from "../agent/identity/groups.js";
import { lintAccessConfig } from "@open-everywhere/core/agent/access/lint.js";

const problems = lintAccessConfig(loadBundles(), loadBindings(), loadDomains(), loadGroups());

if (problems.length > 0) {
  console.error(`✗ access-lint: ${problems.length} problem(s):\n` + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}
const claiming = loadDomains().filter((d) => domainContainers(d).length > 0).length;
console.log(
  `✓ access-lint: broad-grant + method-narrowing lints clean (${loadBundles().length} bundle(s), ${loadBindings().length} binding(s), ${loadDomains().length} domain(s) of which ${claiming} reach a container, ${loadGroups().length} person-group(s))`,
);
