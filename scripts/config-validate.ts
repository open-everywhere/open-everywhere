import { resolveDomainForChannel } from "@open-everywhere/core/agent/memory/domain.js";
import { resolveCaps, domainNameForScope } from "@open-everywhere/core/agent/spend/caps.js";
import type { Caps } from "@open-everywhere/core/agent/spend/spend.js";
import { resolveAccess, type ResolveRequest } from "@open-everywhere/core/agent/access/resolver.js";
import { compileNetworkPolicy } from "@open-everywhere/core/agent/access/egress.js";
import { boundScopes } from "./config-snapshot-build.js";
import { importAppModule, resolveAppRoot } from "@open-everywhere/core/agent/scaffold/app-root.js";

const APP_ROOT = resolveAppRoot();
await importAppModule("agent/lib/register-config.ts", APP_ROOT);
const { loadBindings, loadBundles } = await importAppModule<typeof import("../agent/access/bundles.js")>("agent/access/bundles.ts", APP_ROOT);
const { loadConnectorCredentials } = await importAppModule<typeof import("../agent/access/connector-credentials.js")>("agent/access/connector-credentials.ts", APP_ROOT);
const { PLUGIN_REGISTRY } = await importAppModule<typeof import("../agent/plugins/registry.js")>("agent/plugins/registry.ts", APP_ROOT);
const { loadDomains, domainsForSurface } = await importAppModule<typeof import("../agent/memory/config/domains.js")>("agent/memory/config/domains.ts", APP_ROOT);
const { loadSpendBudgets } = await importAppModule<typeof import("../agent/spend/budgets.js")>("agent/spend/budgets.ts", APP_ROOT);
const { loadGroups } = await importAppModule<typeof import("../agent/identity/groups.js")>("agent/identity/groups.ts", APP_ROOT);

let checked = 0;
const problems: string[] = [];

function fail(msg: string): void {
  problems.push(msg);
}

const domains = loadDomains();

for (const scope of boundScopes()) {
  const req: ResolveRequest = {
    mode: "channel",
    platform: scope.platform,
    workspace: scope.workspace,
    channel: scope.channel,
    domains: domainsForSurface({ workspaceKey: `${scope.platform}/${scope.workspace}`, surface: scope.channel }),
  };
  const access = resolveAccess(req, loadBundles(), loadBindings(), PLUGIN_REGISTRY, loadConnectorCredentials());
  try {
    const policy = await compileNetworkPolicy(access, async () => ({ authorization: "<redacted>" }), async (ids) => ids);
    if (access.reachableHosts.length === 0 && policy !== "deny-all") {
      fail(`${scope.via}: no reachable hosts but policy is not "deny-all" (${JSON.stringify(policy)}) — fail-closed broken`);
    }
    checked++;
    const routedVia = resolveDomainForChannel(`${scope.platform}/${scope.workspace}/${scope.channel}`, domains);
    console.log(`  ✓ ${scope.platform}/${scope.workspace}/${scope.channel}  (${scope.via}; domain ${routedVia.domain?.name ?? "none"} via ${routedVia.via}) — ${access.reachableHosts.length} host(s), ${access.connections.length} credential(s)`);
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
    loadConnectorCredentials(),
  );
  const unbound = resolveAccess(
    { mode: "channel", platform: "slack", workspace: "T__UNBOUND__", channel: "C__UNBOUND__", domains: [] },
    loadBundles(),
    loadBindings(),
    PLUGIN_REGISTRY,
    loadConnectorCredentials(),
  );
  const widened =
    unbound.connections.length > orgOnly.connections.length ||
    unbound.repos.length > orgOnly.repos.length ||
    unbound.connectors.length > orgOnly.connectors.length ||
    unbound.reachableHosts.length > orgOnly.reachableHosts.length;
  if (widened) fail("an UNBOUND probe channel resolves to more than the org baseline — default-deny broken");
  else checked++;
  const policy = await compileNetworkPolicy(unbound, async () => ({ authorization: "<redacted>" }), async (ids) => ids);
  if (unbound.reachableHosts.length === 0 && policy !== "deny-all") fail("unbound probe with no hosts did not compile to deny-all");
  else checked++;
}

{
  const budgets = loadSpendBudgets();
  const domainNames = new Set(domains.map((d) => d.name));
  for (const key of Object.keys(budgets.perDomain ?? {})) {
    if (!domainNames.has(key)) {
      fail(`spend budget perDomain["${key}"] names no declared domain — it caps nothing (declared: ${[...domainNames].sort().join(", ")})`);
    } else checked++;
  }
  for (const key of Object.keys(budgets.perSurface ?? {})) {
    if (resolveDomainForChannel(key, domains).domain === undefined) {
      console.log(`  ⚠️  spend budget perSurface["${key}"] is in no domain roster — it still caps that exact surface key, but check the id`);
    } else checked++;
  }
  const pinCaps = (room: string, what: string, expected: Caps): void => {
    const caps = resolveCaps(room.split("/").slice(0, 2).join("/"), room, domainNameForScope(room));
    for (const [field, want] of Object.entries(expected) as [keyof Caps, number][]) {
      if (caps[field] !== want) {
        fail(`${room} (${what}) resolves to ${JSON.stringify(caps)} — expected ${field}=${want} (OPE-1705)`);
        return;
      }
    }
    checked++;
  };
  pinCaps("slack/T0EXAMPLE/C0EXGENRL", "#general, the e2e-connector fixture room", { surfaceMonthlyUsd: 50 });
  const guild = "discord/1300000000000000100";
  const guildBreaker = budgets.perWorkspace?.[guild]?.workspaceMonthlyUsd;
  if (guildBreaker === undefined) {
    fail(`spend budget perWorkspace["${guild}"] carries no workspaceMonthlyUsd — the driver bot's circuit breaker is gone (OPE-1705)`);
  } else {
    pinCaps(`${guild}/1300000000000000101`, "the Discord driver-bot guild's #general", { surfaceMonthlyUsd: 50, workspaceMonthlyUsd: guildBreaker });
  }
  pinCaps("slack/T0EXAMPLE/C0EXCHAN007", "#oe-e2e-cap, S10's cap-refusal fixture", { surfaceMonthlyUsd: 0.01, surfaceMonthlyTokens: 10_000 });
}

if (problems.length > 0) {
  console.error(`\n✗ config-validate: ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`✓ config-validate: merged config loads clean (${loadGroups().length} person-group(s)); ${checked} scope checks passed (fail-closed verified)`);
