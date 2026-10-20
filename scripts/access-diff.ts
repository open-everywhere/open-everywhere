import { readFileSync } from "node:fs";
import { groupsForPrincipal } from "@open-everywhere/core/agent/identity/groups.js";
import { resolveDomainForChannel } from "@open-everywhere/core/agent/memory/domain.js";
import { resolveAccess, type EffectiveAccess } from "@open-everywhere/core/agent/access/resolver.js";
import { emptyGrantsFile, parseGrantsModule, type GrantsFile } from "@open-everywhere/core/agent/access/grants-codemod.js";
import { describeEffectiveAccess } from "./config-snapshot-diff.js";
import { importAppModule, resolveAppRoot } from "@open-everywhere/core/agent/scaffold/app-root.js";

const APP_ROOT = resolveAppRoot();
await importAppModule("agent/lib/register-config.ts", APP_ROOT);
const { loadBaseBundles, loadBaseBindings } = await importAppModule<typeof import("../agent/access/bundles.js")>("agent/access/bundles.ts", APP_ROOT);
const { loadConnectorCredentials } = await importAppModule<typeof import("../agent/access/connector-credentials.js")>("agent/access/connector-credentials.ts", APP_ROOT);
const { PLUGIN_REGISTRY } = await importAppModule<typeof import("../agent/plugins/registry.js")>("agent/plugins/registry.ts", APP_ROOT);
const { domainsForSurface, loadDomains } = await importAppModule<typeof import("../agent/memory/config/domains.js")>("agent/memory/config/domains.ts", APP_ROOT);
const { loadGroups } = await importAppModule<typeof import("../agent/identity/groups.js")>("agent/identity/groups.ts", APP_ROOT);

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || i + 1 >= process.argv.length) {
    console.error(`usage: access-diff.ts --before <grants overlay module> --after <grants overlay module>`);
    process.exit(2);
  }
  return process.argv[i + 1];
}

function readOverlay(path: string): GrantsFile {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return emptyGrantsFile();
  }
  return text.trim() === "" ? emptyGrantsFile() : parseGrantsModule(text);
}

const before: GrantsFile = readOverlay(arg("before"));
const after: GrantsFile = readOverlay(arg("after"));

type DiffScope = { readonly level: "surface" | "principal" | "group"; readonly address: string };

const scopes = new Map<string, DiffScope>();
for (const g of [before, after]) {
  for (const b of g.bindings) {
    if (b.scope.level === "surface" && b.scope.surface) scopes.set(`surface:${b.scope.surface}`, { level: "surface", address: b.scope.surface });
    if (b.scope.level === "principal" && b.scope.principal) scopes.set(`principal:${b.scope.principal}`, { level: "principal", address: b.scope.principal });
    if (b.scope.level === "group" && b.scope.group) scopes.set(`group:${b.scope.group}`, { level: "group", address: b.scope.group });
  }
}

function resolveWith(grants: GrantsFile, scope: DiffScope): EffectiveAccess {
  const bundles = [...loadBaseBundles(), ...grants.bundles];
  const bindings = [...loadBaseBindings(), ...grants.bindings];
  const resolve = (req: Parameters<typeof resolveAccess>[0]): EffectiveAccess => resolveAccess(req, bundles, bindings, PLUGIN_REGISTRY, loadConnectorCredentials());
  if (scope.level === "surface") {
    const [platform, workspace, ...rest] = scope.address.split("/");
    const channel = rest.join("/");
    return resolve({
      mode: "channel",
      platform,
      workspace,
      channel,
      domains: domainsForSurface({ workspaceKey: `${platform}/${workspace}`, surface: channel }),
    });
  }
  if (scope.level === "principal") {
    const slash = scope.address.indexOf("/");
    const platform = scope.address.slice(0, slash);
    const principalId = scope.address.slice(slash + 1);
    return resolve({ mode: "dm", platform, workspace: "-", channel: "-", principalId, groups: groupsForPrincipal(loadGroups(), scope.address) });
  }
  return resolve({ mode: "dm", platform: "-", workspace: "-", channel: "-", principalId: "-", groups: [scope.address], callerTrust: "internal" });
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

function scopeEntries(g: GrantsFile, scope: DiffScope): string {
  const names = new Set(
    g.bindings
      .filter((b) => b.scope.level === scope.level && (b.scope.surface ?? b.scope.principal ?? b.scope.group) === scope.address)
      .map((b) => b.bundle),
  );
  return JSON.stringify(g.bundles.filter((b) => names.has(b.name)));
}

function heading(scope: DiffScope): string {
  if (scope.level === "surface") {
    const routing = resolveDomainForChannel(scope.address, loadDomains());
    return `### \`${scope.address}\`  — domain: ${routing.domain?.name ?? "none"} (via ${routing.via})`;
  }
  if (scope.level === "principal") return `### \`${scope.address}\`  — personal DM universe (one person)`;
  const members = loadGroups().find((g) => g.name === scope.address)?.members.length ?? 0;
  return `### \`group:${scope.address}\`  — person-group, ${members} member(s), applying in EACH member's DM`;
}

const out: string[] = ["## Effective-access diff (grants overlay)", ""];
let changedScopes = 0;
let invariantBreaches = 0;

for (const scope of [...scopes.entries()].sort((x, y) => x[0].localeCompare(y[0])).map(([, s]) => s)) {
  const lines = diffLines(describeEffectiveAccess(resolveWith(before, scope)), describeEffectiveAccess(resolveWith(after, scope)));
  const grantsChanged = scopeEntries(before, scope) !== scopeEntries(after, scope);
  if (lines.length === 0) continue;
  changedScopes++;
  out.push(heading(scope), "", "```diff", ...lines, "```", "");
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
