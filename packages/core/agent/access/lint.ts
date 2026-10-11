import { connectorGrantCredential, connectorGrantName, egressHostsOverlap, normaliseEgressHost, type Binding, type Bundle, type Scope } from "./bundle.js";
import { GIT_BROKER_HOSTS, RESERVED_BROKER_HOST_REASON } from "./reserved-hosts.js";
import { isLinkSetRef } from "../identity/link-set-ref.js";
import type { ConnectorCredentials } from "./connector-credentials.js";
import { resolveAccess, type EffectiveAccess } from "./resolver.js";
import type { PluginRegistry } from "../plugins/types.js";
import { parseSurfaceKeyEntry, surfaceKeyEntryContains } from "../identity/surface-key-grammar.js";
import { domainContainers, resolveDomainForChannel, type Domain } from "../memory/domain.js";
import { isLinkSetMember, type Group } from "../identity/groups.js";
import { EVERYONE_GROUP } from "../identity/everyone-group.js";

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
    const containers = domainContainers(d);
    if (containers.length > 0) claims.set(d.name, containers);
  }
  return claims;
}

export function groupWidth(group: Group | undefined, name?: string): string | undefined {
  if (name === EVERYONE_GROUP) {
    return `"${EVERYONE_GROUP}" is the built-in group of EVERY person who DMs the agent — every one of them gets this capability in their own DM`;
  }
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
        ? groupWidth(groupByName.get(binding.scope.group), binding.scope.group)
        : undefined;
    const broad =
      binding.scope.level === "org" || binding.scope.level === "tenant" || claimed !== undefined || wideGroup !== undefined;
    if (binding.allowBroad !== undefined && !broad) {
      const why =
        binding.scope.level === "domain"
          ? ` — a domain binding is only broad while its domain reaches a tenant with a container \`reach\` entry (agent/memory/config/domains/<name>.ts), and "${binding.scope.domain}" reaches none`
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
          `broad credentialed grant (via domain container): bundle "${binding.bundle}" carries ${fields.join(" + ")} bound at domain scope — but domain "${binding.scope.domain}" reaches ${claimed.join(", ")} as container \`reach\` entries (agent/memory/config/domains/<name>.ts), so this reaches EVERY surface those entries match, including ones created later that nobody will ever list. ` +
            `The binding reads as narrow; the width comes from the domain. Either enumerate the domain's surfaces as exact \`reach\` entries, or NARROW the container — a same-level glob (\`platform/<tenant>/<prefix>*\`) with \`exclude\` is strictly less reach than a whole-tenant entry (OPE-417) — or accept it deliberately with allowBroad: "<reason>" on the binding (access/bundle.ts).`,
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
  return [scope.level, scope.tenant ?? "", scope.domain ?? "", scope.surface ?? "", scope.group ?? "", scope.principal ?? "", scope.platform ?? ""].join("\u0000");
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

const ROOM_LEVELS: ReadonlySet<Scope["level"]> = new Set(["org", "tenant", "domain", "surface"]);

function tenantOfSurfaceKey(surface: string | undefined): string | undefined {
  const parts = (surface ?? "").split("/");
  return parts.length >= 3 ? `${parts[0]}/${parts[1]}` : undefined;
}

function bindingsCanCoResolve(a: Scope, b: Scope): boolean {
  const aRoom = ROOM_LEVELS.has(a.level);
  if (aRoom !== ROOM_LEVELS.has(b.level)) return false;
  if (aRoom) {
    if (a.level === "surface" && b.level === "surface") return a.surface === b.surface;
    if (a.level === "tenant" && b.level === "tenant") return a.tenant === b.tenant;
    if (a.level === "tenant" && b.level === "surface") return tenantOfSurfaceKey(b.surface) === a.tenant;
    if (a.level === "surface" && b.level === "tenant") return tenantOfSurfaceKey(a.surface) === b.tenant;
    return true;
  }
  if (a.level === "principal" && b.level === "principal") {
    if (a.principal === undefined || b.principal === undefined) return true;
    if (isLinkSetRef(a.principal) || isLinkSetRef(b.principal)) return true;
    return a.principal === b.principal;
  }
  return true;
}

interface HostClaim {
  readonly host: string;
  readonly via: string;
}

function hostClaimsOf(bundle: Bundle): readonly HostClaim[] {
  return (bundle.connections ?? []).flatMap((c) => c.allowedWebsites.map((h) => ({ host: normaliseEgressHost(h), via: c.id })));
}

function clashingClaims(a: readonly HostClaim[], b: readonly HostClaim[], same: boolean): { ids: string[]; where: string }[] {
  const out: { ids: string[]; where: string }[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < a.length; i++) {
    for (let j = same ? i + 1 : 0; j < b.length; j++) {
      const x = a[i]!;
      const y = b[j]!;
      if (x.via === y.via) continue;
      if (!egressHostsOverlap(x.host, y.host)) continue;
      const ids = [x.via, y.via].sort();
      const hosts = [x.host, y.host].sort();
      const key = `${ids[0]} ${ids[1]} ${hosts[0]} ${hosts[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ids, where: x.host === y.host ? hosts[0]! : `${hosts[0]} (which overlaps ${hosts[1]})` });
    }
  }
  return out;
}

export function lintEgressHostCollisions(bundles: readonly Bundle[], bindings: readonly Binding[]): string[] {
  const problems: string[] = [];
  const claimsByBundle = new Map<string, readonly HostClaim[]>();
  for (const bundle of bundles) claimsByBundle.set(bundle.name, hostClaimsOf(bundle));

  for (const bundle of bundles) {
    const claims = claimsByBundle.get(bundle.name) ?? [];
    for (const clash of clashingClaims(claims, claims, true)) {
      problems.push(
        `bundle "${bundle.name}" has two connections (${clash.ids.join(", ")}) claiming host ${clash.where} — ` +
          `the egress policy stamps ONE credential per host, so the grant listed last wins and the other is dead config. ` +
          `One credential per host per session: give each connection its own host.`,
      );
    }
  }

  const seen = new Set<string>();
  for (let i = 0; i < bindings.length; i++) {
    for (let j = i + 1; j < bindings.length; j++) {
      const a = bindings[i]!;
      const b = bindings[j]!;
      if (a.bundle === b.bundle) continue;
      if (!bindingsCanCoResolve(a.scope, b.scope)) continue;
      const aClaims = claimsByBundle.get(a.bundle);
      const bClaims = claimsByBundle.get(b.bundle);
      if (aClaims === undefined || bClaims === undefined) continue;
      for (const clash of clashingClaims(aClaims, bClaims, false)) {
        const pair = [a.bundle, b.bundle].sort();
        const key = `${pair[0]}\u0000${pair[1]}\u0000${clash.where}`;
        if (seen.has(key)) continue;
        seen.add(key);
        problems.push(
          `bundles "${pair[0]}" and "${pair[1]}" can both be in one session's reach ` +
            `(${scopeLabel(a.scope)} + ${scopeLabel(b.scope)}) and their connections (${clash.ids.join(", ")}) both claim host ${clash.where} — ` +
            `the egress policy stamps ONE credential per host, so that session would authenticate with whichever connection resolves last. ` +
            `One credential per host per session: bind them at scopes that never resolve together, or give each connection its own host.`,
        );
      }
    }
  }

  return problems;
}

export function lintReservedBrokerHosts(bundles: readonly Bundle[]): string[] {
  const reserved = GIT_BROKER_HOSTS.map((h) => normaliseEgressHost(h));
  const problems: string[] = [];
  for (const bundle of bundles) {
    for (const claim of hostClaimsOf(bundle)) {
      const hit = reserved.find((r) => egressHostsOverlap(claim.host, r));
      if (hit === undefined) continue;
      problems.push(
        `  bundle "${bundle.name}" connection "${claim.via}" claims host ${claim.host === hit ? claim.host : `${claim.host} (which overlaps ${hit})`} — ` +
          RESERVED_BROKER_HOST_REASON,
      );
    }
  }
  return problems;
}

function domainMemberTenants(
  domain: Domain,
  domains: readonly Domain[],
): Map<string, { future: boolean }> {
  const tenants = new Map<string, { future: boolean }>();
  for (const entry of domain.reach ?? []) {
    const parsed = parseSurfaceKeyEntry(entry);
    if (!parsed || parsed.kind === "group") continue;
    const tenant = `${parsed.platform}/${parsed.tenant}`;
    if (parsed.kind === "surface" && !parsed.glob) {
      if (resolveDomainForChannel(entry, domains).domain?.name !== domain.name) continue;
      if (!tenants.has(tenant)) tenants.set(tenant, { future: false });
      continue;
    }
    const fullyExcluded = (domain.exclude ?? []).some((raw) => {
      const excluded = parseSurfaceKeyEntry(raw);
      return excluded !== undefined && surfaceKeyEntryContains(excluded, parsed);
    });
    if (fullyExcluded) continue;
    tenants.set(tenant, { future: true });
  }
  return tenants;
}

function approverIdentity(approverIds: Map<Function, number>, fn: Function): number {
  const found = approverIds.get(fn);
  if (found !== undefined) return found;
  const id = approverIds.size + 1;
  approverIds.set(fn, id);
  return id;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function unordered(values: readonly unknown[]): readonly string[] {
  return values.map(stableJson).sort();
}

function connectionFact(connection: EffectiveAccess["connections"][number]): unknown {
  return {
    ...connection,
    allowedWebsites: [...connection.allowedWebsites].sort(),
    ...(connection.pathPrefixes === undefined ? {} : { pathPrefixes: [...connection.pathPrefixes].sort() }),
    ...(connection.methods === undefined ? {} : { methods: [...connection.methods].sort() }),
  };
}

function reachableHostFact(host: EffectiveAccess["reachableHosts"][number]): unknown {
  return {
    ...host,
    ...(host.pathPrefixes === undefined ? {} : { pathPrefixes: [...host.pathPrefixes].sort() }),
    ...(host.methods === undefined ? {} : { methods: [...host.methods].sort() }),
  };
}

function setValuedRecord(record: Readonly<Record<string, readonly unknown[]>>): Readonly<Record<string, readonly string[]>> {
  return Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => a.localeCompare(b)).map(([key, values]) => [key, unordered(values)]),
  );
}

function connectorCredentialFacts(access: EffectiveAccess): unknown {
  return Object.fromEntries(
    Object.entries(access.connectorCredentials).sort(([a], [b]) => a.localeCompare(b)).map(([key, credential]) => [
      key,
      {
        ...credential,
        ...(credential.endpoints === undefined
          ? {}
          : {
              endpoints: {
                ...credential.endpoints,
                hosts: [...credential.endpoints.hosts].sort(),
                ...(credential.endpoints.pathPrefixes === undefined ? {} : { pathPrefixes: [...credential.endpoints.pathPrefixes].sort() }),
                ...(credential.endpoints.methods === undefined ? {} : { methods: [...credential.endpoints.methods].sort() }),
              },
            }),
      },
    ]),
  );
}

function staticCapabilityFingerprint(
  access: EffectiveAccess,
  approverIds: Map<Function, number>,
): string {
  const scopeRung = (source: string): string => source.split(":", 1)[0] ?? source;
  return stableJson({
    connections: unordered(access.connections.map(connectionFact)),
    reachableHosts: unordered(access.reachableHosts.map(reachableHostFact)),
    repos: access.repos,
    repoCapabilities: setValuedRecord(access.repoCapabilities),
    resourceCapabilities: setValuedRecord(access.resourceCapabilities),
    awsRoles: unordered(access.awsRoles.map((role) => ({ ...role, allow: [...role.allow].sort() }))),
    approvers: access.approvers.map((a) => ({
      name: a.name,
      source: a.source,
      mayAllow: a.mayAllow,
      approve: approverIdentity(approverIds, a.approve),
    })),
    plugins: access.plugins,
    skills: access.skills,
    subagents: access.subagents,
    connectors: access.connectors,
    connectorContentOrigin: access.connectorContentOrigin,
    connectorCredentials: connectorCredentialFacts(access),
    instructionStack: access.instructionStack.map((layer) => ({ scope: scopeRung(layer.source), text: layer.text })),
    preApprovalRules: access.preApprovalRules.map((rule) => ({ scope: scopeRung(rule.scope), id: rule.id, rule: rule.rule })),
  });
}

export function lintDomainCapabilityConsistency(
  bundles: readonly Bundle[],
  bindings: readonly Binding[],
  domains: readonly Domain[] = [],
  registry: PluginRegistry = {},
  connectorCredentials: readonly ConnectorCredentials[] = [],
): string[] {
  const problems: string[] = [];

  for (const binding of bindings) {
    if (binding.scope.level !== "surface" || binding.scope.surface === undefined) continue;
    const owner = resolveDomainForChannel(binding.scope.surface, domains).domain;
    if (!owner) continue;
    problems.push(
      `direct surface binding: surface "${binding.scope.surface}" belongs to domain "${owner.name}", but bundle "${binding.bundle}" is bound directly to that surface. ` +
        `A domain is one capability boundary even when its sessions are separate: move this grant to { level: "domain", domain: "${owner.name}" }, or remove the surface from that domain before binding it directly.`,
    );
  }

  const staticBindings = bindings.filter((binding) => binding.scope.level !== "surface");
  const approverIds = new Map<Function, number>();
  for (const domain of domains) {
    if (!domain.reach) continue;
    const tenants = domainMemberTenants(domain, domains);
    if (tenants.size < 2) continue;

    const byFingerprint = new Map<string, string[]>();
    for (const tenant of [...tenants.keys()].sort()) {
      const parsed = parseSurfaceKeyEntry(tenant);
      if (!parsed || parsed.kind !== "tenant") continue;
      const access = resolveAccess(
        {
          mode: "channel",
          platform: parsed.platform,
          workspace: parsed.tenant,
          channel: "__domain_capability_consistency__",
          domains: [domain.name],
        },
        bundles,
        staticBindings,
        registry,
        connectorCredentials,
      );
      const fingerprint = staticCapabilityFingerprint(access, approverIds);
      const group = byFingerprint.get(fingerprint) ?? [];
      group.push(tenant);
      byFingerprint.set(fingerprint, group);
    }
    if (byFingerprint.size < 2) continue;

    const facts = [...byFingerprint.values()]
      .map((group) => group.join(", "))
      .sort()
      .map((group, index) => `capability set ${index + 1}: ${group}`)
      .join("; ");
    const future = [...tenants.entries()].filter(([, detail]) => detail.future).map(([tenant]) => tenant).sort();
    problems.push(
      `domain "${domain.name}" resolves different static capabilities for its member tenants (${facts}). ` +
        `${future.length > 0 ? `Its container reach includes future surfaces under ${future.join(", ")}. ` : ""}` +
        `Move tenant-only capability bindings to { level: "domain", domain: "${domain.name}" }, split the domain, or remove the broader grant; every member of one domain must receive the same static capability facts.`,
    );
  }

  return problems;
}

export function ownAccountWithholdingProblems(
  connectors: readonly string[],
  catalogues: readonly ConnectorCredentials[],
  bundles: readonly Bundle[] = [],
): string[] {
  const byConnector = new Map(catalogues.map((c) => [c.connector, c]));
  const problems: string[] = [];
  for (const connector of [...new Set(connectors)].sort()) {
    const catalogue = byConnector.get(connector);
    const hosts = (catalogue?.credentials ?? []).flatMap((c) => c.endpoints?.hosts ?? []).map((h) => normaliseEgressHost(h));
    if (hosts.length === 0) {
      problems.push(
        `  connector "${connector}" admits a credential grant (CREDENTIAL_GRANT_ROLES, access/credential-grant.ts) but ` +
          `${catalogue === undefined ? "has NO credential catalogue" : "no credential in its catalogue declares `endpoints.hosts`"}` +
          ` — so the resolver cannot tell which hosts carry this vendor's key, and an "act with my own account" ask on the` +
          ` egress route withholds nothing and is answered on the TEAM credential (OPE-1549). Declare the vendor's hosts on` +
          ` at least one of its credentials in agent/access/connector-credentials.ts.`,
      );
      continue;
    }
    const secrets = new Set((catalogue?.credentials ?? []).map((c) => c.secretRef));
    for (const bundle of bundles) {
      for (const c of bundle.connections ?? []) {
        const stamped = [c.secretRef, ...(c.customHeaders ?? []).map((h) => h.secretRef)];
        if (!stamped.some((ref) => secrets.has(ref))) continue;
        const claims = c.allowedWebsites.map((h) => normaliseEgressHost(h));
        if (claims.some((h) => hosts.some((v) => egressHostsOverlap(h, v)))) continue;
        problems.push(
          `  bundle "${bundle.name}" connection "${c.id}" stamps a secret that connector "${connector}"'s catalogue also ` +
            `names, but it reaches none of that catalogue's declared hosts (it reaches ${claims.join(", ")}; the catalogue ` +
            `declares ${hosts.join(", ")}). The own-account withholding identifies a vendor's connections BY REACH, so it ` +
            `cannot see this one — an "act with my own account" ask leaves every host it reaches on the TEAM credential ` +
            `(OPE-1684). Add one of those hosts to \`endpoints.hosts\` in agent/access/connector-credentials.ts, or give ` +
            `this connection its own secret.`,
        );
      }
    }
  }
  return problems;
}

function scopeLabel(scope: Scope): string {
  const address = scope.tenant ?? scope.domain ?? scope.surface ?? scope.group ?? scope.principal;
  return address === undefined ? scope.level : `${scope.level} ${address}`;
}

export function lintAccessConfig(
  bundles: readonly Bundle[],
  bindings: readonly Binding[],
  domains: readonly Domain[] = [],
  groups: readonly Group[] = [],
  registry: PluginRegistry = {},
  connectorCredentials: readonly ConnectorCredentials[] = [],
): string[] {
  return [
    ...lintBroadGrants(bundles, bindings, domains, groups),
    ...lintDomainCapabilityConsistency(bundles, bindings, domains, registry, connectorCredentials),
    ...lintMethodNarrowing(bundles),
    ...lintCredentialCollisions(bundles, bindings),
    ...lintEgressHostCollisions(bundles, bindings),
    ...lintReservedBrokerHosts(bundles),
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
