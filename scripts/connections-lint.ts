import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bundleConnectorNames, noteDeprecatedContentOrigin } from "@open-everywhere/core/agent/access/bundle.js";
import { connectorGrantCredentialProblems, ownAccountWithholdingProblems } from "@open-everywhere/core/agent/access/lint.js";
import { credentialGrantConnectors } from "@open-everywhere/core/agent/access/credential-grant.js";
import { importAppModule, resolveAppRoot } from "@open-everywhere/core/agent/scaffold/app-root.js";

const APP_ROOT = resolveAppRoot();
const { loadBundles } = await importAppModule<typeof import("../agent/access/bundles.js")>("agent/access/bundles.ts", APP_ROOT);
const { loadConnectorCredentials } = await importAppModule<typeof import("../agent/access/connector-credentials.js")>("agent/access/connector-credentials.ts", APP_ROOT);

const connectionsDir = join(APP_ROOT, "agent", "connections");
const toolsDir = join(APP_ROOT, "agent", "tools");

// A connection mounts in one of two forms: an eve connection file under agent/connections/, or an
// OE connector mount (connector-mount.ts) under agent/tools/. The roster shim of a connector mount
// re-exports a module under agent/connections/, and a declared MCP server's stub calls
// declaredMcpServerConnection, so the file text names the form.
const CONNECTOR_MOUNT_TEXT = /\/agent\/connections\/[A-Za-z0-9_-]+\.js["']|\bdeclaredMcpServerConnection\b|\bdefineConnectorMount\b|\bbuildMcpConnection\b/u;

function slotFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.startsWith("_") && f !== "connector-auth.ts");
  } catch {
    return [];
  }
}

const mounted: string[] = [
  ...slotFiles(connectionsDir).map((f) => f.replace(/\.ts$/u, "")),
  ...slotFiles(toolsDir)
    .filter((f) => CONNECTOR_MOUNT_TEXT.test(readFileSync(join(toolsDir, f), "utf8")))
    .map((f) => f.replace(/\.ts$/u, "")),
];

const granted = new Set<string>();
for (const bundle of loadBundles()) {
  for (const name of bundleConnectorNames(bundle)) granted.add(name);
}

const credentialProblems = connectorGrantCredentialProblems(loadBundles(), loadConnectorCredentials());

const withholdingProblems = ownAccountWithholdingProblems(credentialGrantConnectors(), loadConnectorCredentials(), loadBundles());

noteDeprecatedContentOrigin(loadBundles());

const ungrantedMounts = mounted.filter((name) => !granted.has(name));
const unmountedGrants = [...granted].filter((name) => !mounted.includes(name)).sort();

let failed = false;
if (unmountedGrants.length > 0) {
  failed = true;
  console.error(
    `✗ connections-lint: granted with NO mounted connection file: ${unmountedGrants.join(", ")}\n` +
      `  The grant silently does nothing — no agent/tools/<name>.ts connector mount exists for Eve to\n` +
      `  mount. Either mount the connection (declare it in agent/access/mcp-servers.ts, then run npx oe build) or remove\n` +
      `  the grant from agent/access/bundles.ts.`,
  );
}
if (ungrantedMounts.length > 0) {
  failed = true;
  console.error(
    `✗ connections-lint: mounted with NO bundle grant: ${ungrantedMounts.join(", ")}\n` +
      `  Eve advertises these to every session. Either grant each one on a bundle\n` +
      `  (connectors: [{ name: "<name>", credential: "<id>" }])\n` +
      `  in agent/access/bundles.ts, or remove the mount until a bundle needs it.`,
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
if (withholdingProblems.length > 0) {
  failed = true;
  console.error(
    `✗ connections-lint: credential-grant connector(s) whose catalogue names no endpoint hosts:\n${withholdingProblems.join("\n")}\n` +
      `  Without those hosts the own-account refusal on the egress route withholds nothing, so a member\n` +
      `  asking to act with their own account is answered on the deployment's own credential.`,
  );
}
if (failed) process.exit(1);
console.log(
  `✓ connections-lint: ${mounted.length} mounted connection(s), all granted (${granted.size} grant(s) total), every grant names a configured credential, every credential-grant connector declares its endpoint hosts`,
);
