import "../agent/lib/register-config.js";
import { loadBindings, loadBundles } from "../agent/access/bundles.js";
import { loadProviders } from "../agent/access/providers.js";
import { PLUGIN_REGISTRY } from "../agent/plugins/registry.js";
import { loadDomains, domainsForSurface } from "../agent/memory/domains.js";
import { resolveAccess, type ResolveRequest } from "@open-everywhere/core/agent/access/resolver.js";
import { compileNetworkPolicy } from "@open-everywhere/core/agent/access/egress.js";

let checked = 0;
const problems: string[] = [];

function fail(msg: string): void {
  problems.push(msg);
}

const domains = loadDomains();

function splitSurfaceKey(key: string): { platform: string; workspace: string; channel: string } | undefined {
  const [platform, workspace, ...rest] = key.split("/");
  if (!platform || !workspace || rest.length === 0 || !rest.join("/")) return undefined;
  return { platform, workspace, channel: rest.join("/") };
}

function boundScopes(): { platform: string; workspace: string; channel: string; via: string }[] {
  const out = new Map<string, { platform: string; workspace: string; channel: string; via: string }>();
  const add = (platform: string, workspace: string, channel: string, via: string) =>
    out.set(`${platform}/${workspace}/${channel}`, { platform, workspace, channel, via });

  for (const b of loadBindings()) {
    const s = b.scope;
    if (s.level === "surface") {
      const parts = splitSurfaceKey(s.surface!);
      if (parts) add(parts.platform, parts.workspace, parts.channel, `surface binding "${b.bundle}"`);
    }
    if (s.level === "tenant") {
      const [platform, workspace] = s.tenant!.split("/");
      if (platform && workspace) add(platform, workspace, "C__PROBE__", `tenant binding "${b.bundle}" (probe channel)`);
    }
    if (s.level === "domain") {
      const domain = domains.find((d) => d.name === s.domain);
      for (const key of domain?.channels ?? []) {
        const parts = splitSurfaceKey(key);
        if (parts) add(parts.platform, parts.workspace, parts.channel, `domain binding "${b.bundle}" via ${s.domain}`);
      }
    }
    if (s.level === "org") add("slack", "T__PROBE__", "C__PROBE__", `org binding "${b.bundle}" (probe scope)`);
  }
  return [...out.values()];
}

for (const scope of boundScopes()) {
  const req: ResolveRequest = {
    mode: "channel",
    platform: scope.platform,
    workspace: scope.workspace,
    channel: scope.channel,
    domains: domainsForSurface({ workspaceKey: `${scope.platform}/${scope.workspace}`, surface: scope.channel }),
  };
  const access = resolveAccess(req, loadBundles(), loadBindings(), PLUGIN_REGISTRY, loadProviders());
  try {
    const policy = await compileNetworkPolicy(access, async () => ({ authorization: "<redacted>" }));
    if (access.reachableHosts.length === 0 && policy !== "deny-all") {
      fail(`${scope.via}: no reachable hosts but policy is not "deny-all" (${JSON.stringify(policy)}) — fail-closed broken`);
    }
    checked++;
    console.log(`  ✓ ${scope.platform}/${scope.workspace}/${scope.channel}  (${scope.via}) — ${access.reachableHosts.length} host(s), ${access.connections.length} credential(s)`);
  } catch (err) {
    fail(`${scope.via}: compileNetworkPolicy threw — ${err instanceof Error ? err.message : String(err)}`);
  }
}

{
  const orgOnly = resolveAccess(
    { mode: "channel", platform: "slack", workspace: "T__PROBE__", channel: "C__PROBE__", domains: [] },
    loadBundles(),
    loadBindings(),
    PLUGIN_REGISTRY,
    loadProviders(),
  );
  const unbound = resolveAccess(
    { mode: "channel", platform: "slack", workspace: "T__UNBOUND__", channel: "C__UNBOUND__", domains: [] },
    loadBundles(),
    loadBindings(),
    PLUGIN_REGISTRY,
    loadProviders(),
  );
  const widened =
    unbound.connections.length > orgOnly.connections.length ||
    unbound.repos.length > orgOnly.repos.length ||
    unbound.connectors.length > orgOnly.connectors.length ||
    unbound.reachableHosts.length > orgOnly.reachableHosts.length;
  if (widened) fail("an UNBOUND probe channel resolves to more than the org baseline — default-deny broken");
  else checked++;
  const policy = await compileNetworkPolicy(unbound, async () => ({ authorization: "<redacted>" }));
  if (unbound.reachableHosts.length === 0 && policy !== "deny-all") fail("unbound probe with no hosts did not compile to deny-all");
  else checked++;
}

if (problems.length > 0) {
  console.error(`\n✗ config-validate: ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`✓ config-validate: merged config loads clean; ${checked} scope checks passed (fail-closed verified)`);
