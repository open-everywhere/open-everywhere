import { resolveDomainForChannel } from "@open-everywhere/core/agent/memory/domain.js";
import { resolveAccess, type ResolveRequest, type SessionMode } from "@open-everywhere/core/agent/access/resolver.js";
import { compileNetworkPolicy } from "@open-everywhere/core/agent/access/egress.js";
import { resolveHeaders } from "@open-everywhere/core/agent/access/credentials.js";
import { importAppModule, resolveAppRoot } from "@open-everywhere/core/agent/scaffold/app-root.js";

const APP_ROOT = resolveAppRoot();
await importAppModule("agent/lib/register-config.ts", APP_ROOT);
const { loadBindings, loadBundles } = await importAppModule<typeof import("../agent/access/bundles.js")>("agent/access/bundles.ts", APP_ROOT);
const { loadConnectorCredentials } = await importAppModule<typeof import("../agent/access/connector-credentials.js")>("agent/access/connector-credentials.ts", APP_ROOT);
const { PLUGIN_REGISTRY } = await importAppModule<typeof import("../agent/plugins/registry.js")>("agent/plugins/registry.ts", APP_ROOT);
const { domainsForSurface, loadDomains } = await importAppModule<typeof import("../agent/memory/config/domains.js")>("agent/memory/config/domains.ts", APP_ROOT);

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const platform = arg("platform", "local")!;
const workspace = arg("workspace", "dev")!;
const channel = arg("channel", "default")!;

const req: ResolveRequest = {
  mode: (arg("mode", "channel") as SessionMode),
  platform,
  workspace,
  channel,
  domains: domainsForSurface({ workspaceKey: `${platform}/${workspace}`, surface: channel }),
  principalId: arg("principal"),
};

const access = resolveAccess(req, loadBundles(), loadBindings(), PLUGIN_REGISTRY, loadConnectorCredentials());

console.log(`\nScope: ${access.scopeKey}  (mode: ${access.mode})`);
const routing = resolveDomainForChannel(`${platform}/${workspace}/${channel}`, loadDomains());
console.log(
  routing.domain
    ? `Domain: ${routing.domain.name}  (via ${routing.via})`
    : `Domain: (none — no channels entry and no containers claim covers ${platform}/${workspace}/${channel})`,
);
console.log("─".repeat(60));

console.log("\nReachable hosts (everything else is denied):");
if (access.reachableHosts.length === 0) console.log("  (none — fully denied)");
for (const h of access.reachableHosts) {
  console.log(`  • ${h.host}${h.viaConnection ? `  [auth via ${h.viaConnection}]` : "  [no credential]"}` +
    (h.methods ? `  methods=${h.methods.join(",")}` : "") +
    (h.pathPrefixes ? `  path=${h.pathPrefixes.join(",")}` : ""));
}

console.log("\nCredentials (narrowest-wins, secrets hidden):");
if (access.connections.length === 0) console.log("  (none)");
for (const c of access.connections) {
  console.log(`  • ${c.id}  type=${c.credentialType}  secretRef=$${c.secretRef}  -> ${c.allowedWebsites.join(", ")}`);
}

console.log(`\nRepos: ${access.repos.length ? access.repos.join(", ") : "(none)"}`);
console.log(`Plugins: ${access.plugins.length ? access.plugins.join(", ") : "(none)"}`);
console.log(`Skills (granted, scoped): ${access.skills.length ? access.skills.join(", ") : "(none)"}`);
console.log(`Subagents: ${access.subagents.length ? access.subagents.join(", ") : "(none)"}`);
console.log(`Connectors (host-side, agent/connections/*): ${access.connectors.length ? access.connectors.join(", ") : "(none)"}`);
const credEntries = Object.entries(access.connectorCredentials);
console.log(`Connector credentials (narrowest-wins per connector, secrets hidden): ${credEntries.length ? "" : "(none)"}`);
for (const [slug, cred] of credEntries) {
  console.log(`  • ${slug}  <- credential "${cred.credential}"  type=${cred.type}  principal=${cred.principal}`);
}

console.log("\nInstruction precedence stack (org → workspace → channel):");
if (access.instructionStack.length === 0) console.log("  (none)");
for (const l of access.instructionStack) console.log(`  [${l.source}] ${l.text}`);

if (access.warnings.length) {
  console.log("\n⚠ Warnings:");
  for (const w of access.warnings) console.log(`  • ${w}`);
}

const redacted = await compileNetworkPolicy(
  access,
  async (c) => {
    try {
      await resolveHeaders(c);
      return { authorization: "<redacted>" };
    } catch (err) {
      console.log(`\n  note: connection "${c.id}" — ${String(err)}`);
      return { authorization: "<unavailable>" };
    }
  },
  async (ids) => ids,
);
console.log("\nCompiled NetworkPolicy (firewall):");
console.log(typeof redacted === "string" ? `  ${redacted}` : JSON.stringify(redacted.allow, null, 2).split("\n").map((l) => "  " + l).join("\n"));
console.log();
