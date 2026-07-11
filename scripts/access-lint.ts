import { loadBundles, loadBindings } from "../agent/access/bundles.js";
import { lintAccessConfig } from "@open-everywhere/core/agent/access/lint.js";

const problems = lintAccessConfig(loadBundles(), loadBindings());

if (problems.length > 0) {
  console.error(`✗ access-lint: ${problems.length} problem(s):\n` + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}
console.log(`✓ access-lint: broad-grant + method-narrowing lints clean (${loadBundles().length} bundle(s), ${loadBindings().length} binding(s))`);
