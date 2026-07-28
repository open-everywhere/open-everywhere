import { readFileSync } from "node:fs";
import "../agent/lib/register-config.js";
import { loadBaseBundles, loadBaseBindings } from "../agent/access/bundles.js";
import { loadProviders } from "../agent/access/providers.js";
import { PLUGIN_REGISTRY } from "../agent/plugins/registry.js";
import { domainsForSurface, loadDomains } from "../agent/memory/domains.js";
import { resolveDomainForChannel } from "@open-everywhere/core/agent/memory/domain.js";
import { resolveAccess, type EffectiveAccess } from "@open-everywhere/core/agent/access/resolver.js";
import { parseGrantsText, type GrantsFile } from "@open-everywhere/core/agent/access/grants-codemod.js";

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || i + 1 >= process.argv.length) {
    console.error(`usage: access-diff.ts --before <grants.json> --after <grants.json>`);
    process.exit(2);
  }
  return process.argv[i + 1];
}

const before: GrantsFile = parseGrantsText(readFileSync(arg("before"), "utf8"));
const after: GrantsFile = parseGrantsText(readFileSync(arg("after"), "utf8"));

const scopes = new Set<string>();
for (const g of [before, after]) {
  for (const b of g.bindings) if (b.scope.surface) scopes.add(b.scope.surface);
}

function resolveWith(grants: GrantsFile, surfaceKey: string): EffectiveAccess {
  const [platform, workspace, ...rest] = surfaceKey.split("/");
  const channel = rest.join("/");
  return resolveAccess(
    {
      mode: "channel",
      platform,
      workspace,
      channel,
      domains: domainsForSurface({ workspaceKey: `${platform}/${workspace}`, surface: channel }),
    },
    [...loadBaseBundles(), ...grants.bundles],
    [...loadBaseBindings(), ...grants.bindings],
    PLUGIN_REGISTRY,
    loadProviders(),
  );
}

function snapshot(a: EffectiveAccess): Record<string, string[]> {
  return {
    hosts: a.reachableHosts.map((h) => `${h.host}${h.viaConnection ? ` [auth via ${h.viaConnection}]` : ""}${h.methods ? ` methods=${[...h.methods].join(",")}` : ""}${h.pathPrefixes ? ` paths=${[...h.pathPrefixes].join(",")}` : ""}`),
    connections: a.connections.map((c) => `${c.id} (${c.credentialType} → ${c.allowedWebsites.join(",")}; methods=${c.methods?.join(",") ?? "all"}; paths=${c.pathPrefixes?.join(",") ?? "all"})`),
    connectors: [...a.connectors],
    repos: [...a.repos],
  };
}

function diffLines(b: Record<string, string[]>, a: Record<string, string[]>): string[] {
  const lines: string[] = [];
  for (const key of Object.keys(a)) {
    const gained = a[key].filter((x) => !b[key].includes(x));
    const lost = b[key].filter((x) => !a[key].includes(x));
    for (const g of gained) lines.push(`+ ${key}: ${g}`);
    for (const l of lost) lines.push(`- ${key}: ${l}`);
  }
  return lines;
}

function scopeEntries(g: GrantsFile, surfaceKey: string): string {
  const names = new Set(g.bindings.filter((b) => b.scope.surface === surfaceKey).map((b) => b.bundle));
  return JSON.stringify(g.bundles.filter((b) => names.has(b.name)));
}

const out: string[] = ["## Effective-access diff (grants overlay)", ""];
let changedScopes = 0;
let invariantBreaches = 0;

for (const surfaceKey of [...scopes].sort((x, y) => x.localeCompare(y))) {
  const lines = diffLines(snapshot(resolveWith(before, surfaceKey)), snapshot(resolveWith(after, surfaceKey)));
  const grantsChanged = scopeEntries(before, surfaceKey) !== scopeEntries(after, surfaceKey);
  if (lines.length === 0) continue;
  changedScopes++;
  const routing = resolveDomainForChannel(surfaceKey, loadDomains());
  out.push(`### \`${surfaceKey}\`  — domain: ${routing.domain?.name ?? "none"} (via ${routing.via})`, "", "```diff", ...lines, "```", "");
  if (!grantsChanged) {
    invariantBreaches++;
    out.push(`> ⚠️ **INVARIANT BREACH** — this scope's effective access changed but its own overlay entries did not.`, "");
  }
}

out.push(changedScopes === 0 ? "_No scope's effective access changes._" : `**${changedScopes} scope(s) change; no other scope is affected.**`);
console.log(out.join("\n"));

if (invariantBreaches > 0) {
  console.error(`\n✗ access-diff: ${invariantBreaches} scope(s) changed without their own grants changing — the single-scope invariant is broken`);
  process.exit(1);
}
