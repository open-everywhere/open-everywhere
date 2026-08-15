import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadBundles } from "../agent/access/bundles.js";
import { bundleConnectorNames } from "@open-everywhere/core/agent/access/bundle.js";
import { connectorGrantCredentialProblems } from "@open-everywhere/core/agent/access/lint.js";
import { loadConnectorCredentials } from "../agent/access/connector-credentials.js";

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

const granted = new Set<string>();
for (const bundle of loadBundles()) {
  for (const name of bundleConnectorNames(bundle)) granted.add(name);
}

const credentialProblems = connectorGrantCredentialProblems(loadBundles(), loadConnectorCredentials());

const ungrantedMounts = mounted.filter((name) => !granted.has(name));
const unmountedGrants = [...granted].filter((name) => !mounted.includes(name)).sort();

let failed = false;
if (unmountedGrants.length > 0) {
  failed = true;
  console.error(
    `✗ connections-lint: granted with NO mounted connection file: ${unmountedGrants.join(", ")}\n` +
      `  The grant silently does nothing — no agent/connections/<name>.ts exists for Eve to\n` +
      `  mount. Either mount the connection (create agent/connections/<name>.ts) or remove\n` +
      `  the grant from agent/access/bundles.ts.`,
  );
}
if (ungrantedMounts.length > 0) {
  failed = true;
  console.error(
    `✗ connections-lint: mounted with NO bundle grant: ${ungrantedMounts.join(", ")}\n` +
      `  Eve advertises these to every session. Either grant each one on a bundle\n` +
      `  (connectors: [{ name: "<name>", credential: "<id>", contentOrigin: "internal" | "external" }])\n` +
      `  in agent/access/bundles.ts, or delete agent/connections/<name>.ts until a bundle needs it.`,
  );
}
if (credentialProblems.length > 0) {
  failed = true;
  console.error(
    `✗ connections-lint: connector grant(s) naming an unconfigured credential:\n${credentialProblems.join("\n")}\n` +
      `  A grant names the identity it reaches the connector as, and the resolver binds nothing for a\n` +
      `  credential it cannot find — so the capability reads as live and is not.`,
  );
}
if (failed) process.exit(1);
console.log(
  `✓ connections-lint: ${mounted.length} mounted connection(s), all granted (${granted.size} grant(s) total), every grant names a configured credential`,
);
