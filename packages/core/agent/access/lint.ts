import { connectorGrantCredential, connectorGrantName, type Binding, type Bundle } from "./bundle.js";
import type { Domain } from "../memory/domain.js";
import { isLinkSetMember, type Group } from "../identity/groups.js";

export const GROUP_BROAD_MEMBERS = 8;

function credentialedFields(bundle: Bundle): string[] {
  const fields: string[] = [];
  if (bundle.connections?.length) fields.push(`${bundle.connections.length} connection(s)`);
  if (bundle.repos?.length) fields.push(`${bundle.repos.length} repo(s)`);
  if (bundle.connectors?.length) fields.push(`${bundle.connectors.length} connector credential(s)`);
  if (bundle.awsRoles?.length) fields.push(`${bundle.awsRoles.length} AWS role(s)`);
  return fields;
}

function tenantClaims(domains: readonly Domain[]): Map<string, readonly string[]> {
  const claims = new Map<string, readonly string[]>();
  for (const d of domains) {
    if (d.containers && d.containers.length > 0) claims.set(d.name, d.containers);
  }
  return claims;
}

export function groupWidth(group: Group | undefined): string | undefined {
  if (!group) return undefined;
  const sets = group.members.filter(isLinkSetMember).length;
  if (sets > 0) {
    return `it has ${sets} link-set member(s) — each is a HUMAN who resolves to every account they have confirmed, so the DMs this credential reaches grow with no diff to this binding/bundle/group. This is LIVE at runtime: the DM connector gate resolves through the awaitable expander, so confirming a new account into one of these sets grants it this capability in that account's own DM with no change to any file`;
  }
  if (group.members.length >= GROUP_BROAD_MEMBERS) {
    return `it has ${group.members.length} members (at or over the ${GROUP_BROAD_MEMBERS}-member threshold) — every one of them gets this capability in their own DM`;
  }
  return undefined;
}

export function lintBroadGrants(
  bundles: readonly Bundle[],
  bindings: readonly Binding[],
  domains: readonly Domain[] = [],
  groups: readonly Group[] = [],
): string[] {
  const byName = new Map(bundles.map((b) => [b.name, b]));
  const groupByName = new Map(groups.map((g) => [g.name, g]));
  const claims = tenantClaims(domains);
  const problems: string[] = [];
  for (const binding of bindings) {
    const claimed =
      binding.scope.level === "domain" && binding.scope.domain !== undefined
        ? claims.get(binding.scope.domain)
        : undefined;
    const wideGroup =
      binding.scope.level === "group" && binding.scope.group !== undefined
        ? groupWidth(groupByName.get(binding.scope.group))
        : undefined;
    const broad =
      binding.scope.level === "org" || binding.scope.level === "tenant" || claimed !== undefined || wideGroup !== undefined;
    if (binding.allowBroad !== undefined && !broad) {
      const why =
        binding.scope.level === "domain"
          ? ` — a domain binding is only broad while its domain claims a tenant via \`containers\` (agent/memory/domains.ts), and "${binding.scope.domain}" claims none`
          : binding.scope.level === "group"
            ? ` — a group binding is only broad while its group holds a link-set member or ${GROUP_BROAD_MEMBERS}+ members (agent/identity/groups.ts), and "${binding.scope.group}" holds neither`
            : "";
      problems.push(
        `binding "${binding.bundle}" (${binding.scope.level} scope) sets allowBroad but isn't a broad scope${why} — remove the escape (it suggests the binding means something it doesn't)`,
      );
      continue;
    }
    if (!broad) continue;
    const bundle = byName.get(binding.bundle);
    if (!bundle) continue;
    const fields = credentialedFields(bundle);
    if (fields.length === 0) continue;
    if (binding.allowBroad !== undefined && binding.allowBroad.trim() === "") {
      problems.push(`binding "${binding.bundle}" (${binding.scope.level} scope) has an EMPTY allowBroad — the escape must name the reason this broad grant is deliberate`);
      continue;
    }
    if (binding.allowBroad === undefined) {
      if (wideGroup) {
        problems.push(
          `broad credentialed grant (person-group): bundle "${binding.bundle}" carries ${fields.join(" + ")} bound at group scope to "${binding.scope.group}" — ${wideGroup}. ` +
            `A group grants PEOPLE: every member gets this capability in their own DM. Split the group, name the individuals with \`principal\` bindings, or accept it deliberately with allowBroad: "<reason>" on the binding (access/bundle.ts).`,
        );
      } else if (claimed) {
        problems.push(
          `broad credentialed grant (via domain claim): bundle "${binding.bundle}" carries ${fields.join(" + ")} bound at domain scope — but domain "${binding.scope.domain}" claims ${claimed.join(", ")} via \`containers\` (agent/memory/domains.ts), so this reaches EVERY surface those entries match, including ones created later that nobody will ever list. ` +
            `The binding reads as narrow; the width comes from the domain. Either enumerate the domain's surfaces in \`channels\`, or NARROW the claim — a same-level glob (\`platform/<tenant>/<prefix>*\`) with \`excludeContainers\` is strictly less reach than a whole-tenant claim (OPE-417) — or accept it deliberately with allowBroad: "<reason>" on the binding (access/bundle.ts).`,
        );
      } else {
        problems.push(
          `broad credentialed grant: bundle "${binding.bundle}" carries ${fields.join(" + ")} bound at ${binding.scope.level} scope — every surface beneath it (incl. future/public ones) inherits that capability. ` +
            `Bind it to a domain or specific surface instead, or accept it deliberately with allowBroad: "<reason>" on the binding (access/bundle.ts).`,
        );
      }
    }
  }
  return problems;
}

export function lintMethodNarrowing(bundles: readonly Bundle[]): string[] {
  const problems: string[] = [];
  for (const bundle of bundles) {
    for (const c of bundle.connections ?? []) {
      if (!c.methods || c.methods.length === 0) {
        problems.push(
          `bundle "${bundle.name}" connection "${c.id}" declares no \`methods\` — an un-narrowed credentialed connection admits GET and DELETE alike on its granted hosts. ` +
            `Declare the methods it needs: ["GET", "HEAD"] is the read-only standard shape; name mutating methods explicitly so they're a reviewed declaration.`,
        );
      }
    }
  }
  return problems;
}

function bindingScopeKey(scope: Binding["scope"]): string {
  return [scope.level, scope.tenant ?? "", scope.domain ?? "", scope.surface ?? "", scope.group ?? "", scope.principal ?? ""].join("\u0000");
}

export function lintCredentialCollisions(bundles: readonly Bundle[], bindings: readonly Binding[]): string[] {
  const problems: string[] = [];

  for (const bundle of bundles) {
    const byConnector = new Map<string, Set<string>>();
    for (const grant of bundle.connectors ?? []) {
      const credential = connectorGrantCredential(grant);
      if (credential === undefined) continue;
      const name = connectorGrantName(grant);
      const set = byConnector.get(name) ?? new Set<string>();
      set.add(credential);
      byConnector.set(name, set);
    }
    for (const [connector, credentials] of byConnector) {
      if (credentials.size > 1) {
        problems.push(
          `bundle "${bundle.name}" grants connector "${connector}" TWICE with different credentials (${[...credentials].sort().join(", ")}) — ` +
            `the resolver keys one credential per connector, so the winner is whichever entry is listed last. Declaration order is not a decision: name ONE credential for this connector.`,
        );
      }
    }
  }

  const byName = new Map(bundles.map((b) => [b.name, b]));
  const atScope = new Map<string, Map<string, Map<string, Set<string>>>>();
  for (const binding of bindings) {
    const bundle = byName.get(binding.bundle);
    if (!bundle) continue;
    const scopeKey = bindingScopeKey(binding.scope);
    const connectors = atScope.get(scopeKey) ?? new Map<string, Map<string, Set<string>>>();
    for (const grant of bundle.connectors ?? []) {
      const credential = connectorGrantCredential(grant);
      if (credential === undefined) continue;
      const name = connectorGrantName(grant);
      const credentials = connectors.get(name) ?? new Map<string, Set<string>>();
      const owners = credentials.get(credential) ?? new Set<string>();
      owners.add(bundle.name);
      credentials.set(credential, owners);
      connectors.set(name, credentials);
    }
    atScope.set(scopeKey, connectors);
  }
  for (const [scopeKey, connectors] of atScope) {
    for (const [connector, credentials] of connectors) {
      const bundleNames = new Set<string>();
      for (const owners of credentials.values()) for (const b of owners) bundleNames.add(b);
      if (credentials.size > 1 && bundleNames.size > 1) {
        problems.push(
          `bundles ${[...bundleNames].sort().map((b) => `"${b}"`).join(" and ")} are bound at the SAME scope (${scopeKey.replace(/\u0000/g, "/")}) and grant connector "${connector}" with different credentials (${[...credentials.keys()].sort().join(", ")}) — ` +
            `narrowest-wins cannot separate two grants at one scope, so the surface would authenticate with whichever the config lists last. Bind them at different scopes, or agree on one credential.`,
        );
      }
    }
  }

  return problems;
}

export function lintAccessConfig(
  bundles: readonly Bundle[],
  bindings: readonly Binding[],
  domains: readonly Domain[] = [],
  groups: readonly Group[] = [],
): string[] {
  return [
    ...lintBroadGrants(bundles, bindings, domains, groups),
    ...lintMethodNarrowing(bundles),
    ...lintCredentialCollisions(bundles, bindings),
  ];
}

export function connectorGrantCredentialProblems(
  bundles: readonly Bundle[],
  catalogues: readonly { readonly connector: string; readonly credentials: readonly { readonly id: string }[] }[],
): string[] {
  const byConnector = new Map(catalogues.map((c) => [c.connector, c]));
  const problems: string[] = [];
  for (const bundle of bundles) {
    for (const grant of bundle.connectors ?? []) {
      const name = connectorGrantName(grant);
      const credential = connectorGrantCredential(grant);
      if (credential === undefined) {
        problems.push(
          `  bundle "${bundle.name}" grants connector "${name}" with no credential — a grant names the identity it reaches the connector as`,
        );
        continue;
      }
      const catalogue = byConnector.get(name);
      if (!catalogue) {
        problems.push(
          `  bundle "${bundle.name}" grants connector "${name}" as credential "${credential}", but "${name}" has NO credential catalogue` +
            ` — add one to agent/access/connector-credentials.ts`,
        );
        continue;
      }
      if (!catalogue.credentials.some((c) => c.id === credential)) {
        const known = catalogue.credentials.map((c) => c.id).join(", ") || "none";
        problems.push(
          `  bundle "${bundle.name}" grants connector "${name}" as credential "${credential}", which that connector does not configure` +
            ` (configured: ${known}) — the grant resolves to nothing`,
        );
      }
    }
  }
  return problems;
}
