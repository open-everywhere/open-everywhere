import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadBundles } from "../agent/access/bundles.js";
import { loadProviders } from "../agent/access/providers.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const connectionsDir = join(root, "agent", "connections");

let mounted: string[] = [];
try {
  mounted = readdirSync(connectionsDir)
    .filter((f) => f.endsWith(".ts") && !f.startsWith("_") && f !== "connector-auth.ts")
    .map((f) => f.replace(/\.ts$/u, ""));
} catch {
  mounted = [];
}

const providersByName = new Map(loadProviders().map((p) => [p.name, p]));
const granted = new Set<string>();
for (const bundle of loadBundles()) {
  for (const name of bundle.connectors ?? []) granted.add(name);
  for (const g of bundle.providers ?? []) {
    const provider = providersByName.get(g.provider);
    if (provider) granted.add(provider.connection);
  }
}

const ungrantedMounts = mounted.filter((name) => !granted.has(name));
const unmountedGrants = [...granted].filter((name) => !mounted.includes(name)).sort();

if (unmountedGrants.length > 0) {
  console.warn(`⚠ granted but not mounted (inert until the file exists): ${unmountedGrants.join(", ")}`);
}
if (ungrantedMounts.length > 0) {
  console.error(
    `✗ connections-lint: mounted with NO bundle grant: ${ungrantedMounts.join(", ")}\n` +
      `  Eve advertises these to every session. Either grant each one on a bundle\n` +
      `  (connectors: ["<name>"] or a provider grant) in agent/access/bundles.ts,\n` +
      `  or delete agent/connections/<name>.ts until a bundle needs it.`,
  );
  process.exit(1);
}
console.log(`✓ connections-lint: ${mounted.length} mounted connection(s), all granted (${granted.size} grant(s) total)`);
