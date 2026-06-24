import { loadBindings, loadBundles } from "../agent/access/bundles.js";
import { domainsForSurface } from "../agent/memory/domains.js";
import { resolveAccess, type ResolveRequest, type SessionMode } from "../agent/access/resolver.js";
import { compileNetworkPolicy } from "../agent/access/egress.js";
import { resolveHeaders } from "../agent/access/credentials.js";

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

const access = resolveAccess(req, loadBundles(), loadBindings());

console.log(`\nScope: ${access.scopeKey}  (mode: ${access.mode})`);
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
console.log(`Plugins: ${access.plugins.length ? access.plugins.map((p) => `${p.id}(${p.kind})`).join(", ") : "(none)"}`);

console.log("\nInstruction precedence stack (org → workspace → channel):");
if (access.instructionStack.length === 0) console.log("  (none)");
for (const l of access.instructionStack) console.log(`  [${l.source}] ${l.text}`);

if (access.warnings.length) {
  console.log("\n⚠ Warnings:");
  for (const w of access.warnings) console.log(`  • ${w}`);
}

const redacted = await compileNetworkPolicy(access, async (c) => {
  try {
    await resolveHeaders(c);
    return { authorization: "<redacted>" };
  } catch (err) {
    console.log(`\n  note: connection "${c.id}" — ${String(err)}`);
    return { authorization: "<unavailable>" };
  }
});
console.log("\nCompiled NetworkPolicy (firewall):");
console.log(typeof redacted === "string" ? `  ${redacted}` : JSON.stringify(redacted.allow, null, 2).split("\n").map((l) => "  " + l).join("\n"));
console.log();
