import type { AwsRoleGrant, Binding, Bundle, Connection, ConnectorContentOriginSpec, HttpMethod, Scope } from "./bundle.js";
import { connectorGrantName, connectorGrantContentOrigin, connectorGrantCredential, repoGrantName, repoGrantCapabilities } from "./bundle.js";
import { unionRepoCapabilities, type RepoCapability } from "./repo-capabilities.js";
import { unionResourceCapabilities, type ResourceCapability } from "./resource-capabilities.js";
import { resourceGrantCapabilities } from "./resource-grant.js";
import type { OperatorApprover } from "./approver-chain.js";
import {
  assemblePreApprovalRules,
  PRE_APPROVAL_RULES_MAX_ASSEMBLED,
  type ResolvedPreApprovalRule,
} from "./pre-approval-rules.js";
import { tryPrincipalKey } from "../identity/principal-key.js";
import { isLinkSetRef, parseLinkSetRef } from "../identity/link-set-ref.js";
import type { PluginRegistry } from "../plugins/types.js";
import { expandConnectorGrant, type ConnectorCredentials, type ResolvedConnectorCredential } from "./connector-credentials.js";

export type SessionMode = "channel" | "dm" | "mpim";

export interface ResolveRequest {
  readonly mode: SessionMode;
  readonly platform: string;
  readonly workspace: string;
  readonly channel: string;
  readonly domains?: readonly string[];
  readonly principalId?: string;
  readonly groups?: readonly string[];
  readonly principalLinkSets?: readonly string[];
  readonly memberPlane?: readonly string[];
}

export interface ReachableHost {
  readonly host: string;
  readonly viaConnection: string | null;
  readonly methods?: readonly HttpMethod[];
  readonly pathPrefixes?: readonly string[];
}

export interface InstructionLayer {
  readonly source: string;
  readonly text: string;
}

export interface EffectiveAccess {
  readonly mode: SessionMode;
  readonly scopeKey: string;
  readonly domains: readonly string[];
  readonly tenantKey: string;
  readonly surfaceKey: string;
  readonly connections: readonly Connection[];
  readonly reachableHosts: readonly ReachableHost[];
  readonly repos: readonly string[];
  readonly repoCapabilities: Readonly<Record<string, readonly RepoCapability[]>>;
  readonly resourceCapabilities: Readonly<Record<string, readonly ResourceCapability[]>>;
  readonly awsRoles: readonly AwsRoleGrant[];
  readonly approvers: readonly OperatorApprover[];
  readonly plugins: readonly string[];
  readonly skills: readonly string[];
  readonly subagents: readonly string[];
  readonly connectors: readonly string[];
  readonly connectorContentOrigin: Readonly<Record<string, ConnectorContentOriginSpec>>;
  readonly connectorCredentials: Readonly<Record<string, ResolvedConnectorCredential>>;
  readonly instructionStack: readonly InstructionLayer[];
  readonly preApprovalRules: readonly ResolvedPreApprovalRule[];
  readonly warnings: readonly string[];
}

const SPECIFICITY: Record<Scope["level"], number> = { org: 0, tenant: 1, domain: 2, surface: 3, group: 4, principal: 5 };
const PRINCIPAL_LINKSET_SPECIFICITY = 5;
const PRINCIPAL_EXACT_SPECIFICITY = 6;

export function tenantKeyOf(req: Pick<ResolveRequest, "platform" | "workspace">): string {
  return `${req.platform}/${req.workspace}`;
}

export function surfaceKeyOf(req: Pick<ResolveRequest, "platform" | "workspace" | "channel">): string {
  return `${req.platform}/${req.workspace}/${req.channel}`;
}

function scopeLabel(s: Scope): string {
  switch (s.level) {
    case "org":
      return "org";
    case "tenant":
      return `tenant:${s.tenant}`;
    case "domain":
      return `domain:${s.domain}`;
    case "surface":
      return `surface:${s.surface}`;
    case "group":
      return `group:${s.group}`;
    case "principal":
      return `principal:${s.principal}`;
  }
}

function scopeMatches(s: Scope, req: ResolveRequest): boolean {
  switch (s.level) {
    case "org":
      return true;
    case "tenant":
      return s.tenant === tenantKeyOf(req);
    case "domain":
      return req.domains?.includes(s.domain!) ?? false;
    case "surface":
      return s.surface === surfaceKeyOf(req);
    case "group":
      return false;
    case "principal":
      return false;
  }
}

function normHost(h: string): string {
  return h.trim().toLowerCase();
}

function contentOriginKey(spec: ConnectorContentOriginSpec): string {
  if (typeof spec === "string") return spec;
  const except = Object.keys(spec.except)
    .sort()
    .map((tool) => `${tool}=${spec.except[tool]}`)
    .join(",");
  return `${spec.default}{${except}}`;
}

export function resolveAccess(
  req: ResolveRequest,
  bundles: readonly Bundle[],
  bindings: readonly Binding[],
  registry: PluginRegistry = {},
  connectorCredentialsConfig: readonly ConnectorCredentials[] = [],
): EffectiveAccess {
  const warnings: string[] = [];
  const byName = new Map(bundles.map((b) => [b.name, b]));

  const callerKey =
    req.principalId !== undefined ? tryPrincipalKey(req.platform, req.workspace, req.principalId) : undefined;

  const callerGroups = new Set(req.groups ?? []);

  const callerLinkSets = new Set(req.principalLinkSets ?? []);

  const principalMatch = (scope: Scope): number | undefined => {
    if (callerKey === undefined || scope.principal === undefined) return undefined;
    if (scope.principal === callerKey) return PRINCIPAL_EXACT_SPECIFICITY;
    if (isLinkSetRef(scope.principal)) {
      const id = parseLinkSetRef(scope.principal);
      if (id !== undefined && callerLinkSets.has(id)) return PRINCIPAL_LINKSET_SPECIFICITY;
    }
    return undefined;
  };

  const applied: { scope: Scope; bundle: Bundle; specificity: number }[] = [];
  for (const binding of bindings) {
    let specificity: number | undefined;
    if (req.mode === "dm") {
      if (binding.scope.level === "principal") {
        specificity = principalMatch(binding.scope);
      } else if (
        callerKey !== undefined &&
        binding.scope.level === "group" &&
        binding.scope.group !== undefined &&
        callerGroups.has(binding.scope.group)
      ) {
        specificity = SPECIFICITY.group;
      }
    } else if (scopeMatches(binding.scope, req)) {
      specificity = SPECIFICITY[binding.scope.level];
    }
    if (specificity === undefined) continue;
    const bundle = byName.get(binding.bundle);
    if (!bundle) {
      warnings.push(`binding references unknown bundle "${binding.bundle}" — ignored`);
      continue;
    }
    applied.push({ scope: binding.scope, bundle, specificity });
  }

  const ordered = [...applied].sort((a, b) => a.specificity - b.specificity);

  const connById = new Map<string, Connection>();
  for (const { bundle } of ordered) {
    const seenHostsThisBundle = new Map<string, string>();
    for (const c of bundle.connections ?? []) {
      for (const h of c.allowedWebsites) {
        const key = normHost(h);
        const prior = seenHostsThisBundle.get(key);
        if (prior && prior !== c.id) {
          warnings.push(
            `bundle "${bundle.name}" has two connections (${prior}, ${c.id}) claiming host ${h}; resolution order within a scope is undefined`,
          );
        }
        seenHostsThisBundle.set(key, c.id);
      }
      connById.set(c.id, c);
    }
  }
  const connections = [...connById.values()];

  const hostMap = new Map<string, ReachableHost>();
  for (const d of ordered.flatMap(({ bundle }) => bundle.domains ?? [])) {
    const key = normHost(d);
    if (!hostMap.has(key)) hostMap.set(key, { host: key, viaConnection: null });
  }
  for (const c of connections) {
    for (const h of c.allowedWebsites) {
      hostMap.set(normHost(h), {
        host: normHost(h),
        viaConnection: c.id,
        methods: c.methods,
        pathPrefixes: c.pathPrefixes,
      });
    }
  }
  const reachableHosts = [...hostMap.values()].sort((a, b) => a.host.localeCompare(b.host));

  const repos = [...new Set(ordered.flatMap(({ bundle }) => (bundle.repos ?? []).map(repoGrantName)))].sort();

  const repoCapabilityMap = new Map<string, readonly RepoCapability[]>();
  for (const { bundle } of ordered) {
    for (const grant of bundle.repos ?? []) {
      const caps = repoGrantCapabilities(grant);
      if (caps.length === 0) continue;
      const name = repoGrantName(grant);
      repoCapabilityMap.set(name, unionRepoCapabilities(repoCapabilityMap.get(name) ?? [], caps));
    }
  }
  const repoCapabilities: Record<string, readonly RepoCapability[]> = {};
  for (const name of [...repoCapabilityMap.keys()].sort()) repoCapabilities[name] = repoCapabilityMap.get(name)!;

  const resourceCapabilityMap = new Map<string, readonly ResourceCapability[]>();
  for (const { bundle } of ordered) {
    for (const grant of bundle.resourceGrants ?? []) {
      const caps = resourceGrantCapabilities(grant);
      for (const address of grant.resources ?? []) {
        resourceCapabilityMap.set(address, unionResourceCapabilities(resourceCapabilityMap.get(address) ?? [], caps));
      }
    }
  }
  const resourceCapabilities: Record<string, readonly ResourceCapability[]> = {};
  for (const address of [...resourceCapabilityMap.keys()].sort()) resourceCapabilities[address] = resourceCapabilityMap.get(address)!;

  const awsRoleMap = new Map<string, AwsRoleGrant>();
  for (const { bundle } of ordered) {
    for (const grant of bundle.awsRoles ?? []) awsRoleMap.set(grant.roleArn, grant);
  }
  const awsRoles = [...awsRoleMap.values()].sort((a, b) => a.roleArn.localeCompare(b.roleArn));

  const approvers = ordered.flatMap(({ bundle }) => bundle.approvers ?? []);

  const plugins = [...new Set(ordered.flatMap(({ bundle }) => bundle.plugins ?? []))].sort();
  const pluginConnectors = new Set<string>();
  const skillSet = new Set<string>();
  const subagentSet = new Set<string>();
  for (const name of plugins) {
    const entry = registry[name];
    if (!entry) {
      warnings.push(
        `bundle grants unknown plugin "${name}" — not in the plugin registry; contributes nothing`,
      );
      continue;
    }
    for (const c of entry.connectors ?? []) pluginConnectors.add(c);
    for (const s of entry.skills ?? []) skillSet.add(s);
    for (const a of entry.subagents ?? []) subagentSet.add(a);
  }
  const skills = [...skillSet].sort();
  const subagents = [...subagentSet].sort();
  const memberPlaneKeys = req.memberPlane === undefined || req.memberPlane.length === 0 ? undefined : new Set(req.memberPlane);
  const catalogueByConnector = new Map(connectorCredentialsConfig.map((c) => [c.connector, c]));
  const connectorCredentials: Record<string, ResolvedConnectorCredential> = {};
  const grantedConnectors = new Set<string>();
  for (const { bundle } of ordered) {
    for (const grant of bundle.connectors ?? []) {
      const name = connectorGrantName(grant);
      const credential = connectorGrantCredential(grant);
      if (credential === undefined) {
        warnings.push(
          `bundle "${bundle.name}": connector grant "${name}" names no credential — a grant must name the identity it reaches the connector as; ignored`,
        );
        continue;
      }
      const { resolved, warnings: gw } = expandConnectorGrant({ name, credential }, catalogueByConnector.get(name), {
        dm: req.mode === "dm",
        ...(memberPlaneKeys === undefined ? {} : { memberPlane: memberPlaneKeys }),
      });
      for (const w of gw) warnings.push(`bundle "${bundle.name}": ${w}`);
      if (resolved) {
        grantedConnectors.add(resolved.connector);
        connectorCredentials[resolved.connector] = resolved;
      }
    }
  }

  const connectors = [...new Set([...grantedConnectors, ...pluginConnectors])].sort();

  const declaredByName = new Map<string, Map<string, ConnectorContentOriginSpec>>();
  for (const { bundle } of ordered) {
    for (const grant of bundle.connectors ?? []) {
      const declared = connectorGrantContentOrigin(grant);
      if (declared === undefined) continue;
      const name = connectorGrantName(grant);
      if (!grantedConnectors.has(name)) continue;
      const byShape = declaredByName.get(name) ?? new Map<string, ConnectorContentOriginSpec>();
      byShape.set(contentOriginKey(declared), declared);
      declaredByName.set(name, byShape);
    }
  }
  const connectorContentOrigin: Record<string, ConnectorContentOriginSpec> = {};
  for (const [name, declared] of [...declaredByName.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (declared.size > 1) {
      warnings.push(
        `connector "${name}" is declared with DIFFERENT \`contentOrigin\` values (${[...declared.keys()].sort().join(" vs ")}) by bundles bound to this scope — an Eve connection is one global instance, so these are contradictory claims about the same thing; resolving to "external" (fail-closed). Make the declarations agree.`,
      );
      connectorContentOrigin[name] = "external";
      continue;
    }
    connectorContentOrigin[name] = [...declared.values()][0]!;
  }

  const preApprovalRules = assemblePreApprovalRules(
    ordered
      .filter(({ bundle }) => (bundle.preApprovalRules?.length ?? 0) > 0)
      .map(({ scope, bundle }) => ({ scope: scopeLabel(scope), rules: bundle.preApprovalRules! })),
  );
  if (preApprovalRules.dropped > 0) {
    warnings.push(
      `${preApprovalRules.dropped} pre-approval rule(s) exceeded the assembled ceiling of ${PRE_APPROVAL_RULES_MAX_ASSEMBLED} and were dropped (narrowest scope first, so the org's reviewed baseline survives) — reduce the rules bound to this scope.`,
    );
  }

  const instructionStack: InstructionLayer[] = ordered
    .filter(({ bundle }) => bundle.instructions && bundle.instructions.trim().length > 0)
    .map(({ scope, bundle }) => ({ source: scopeLabel(scope), text: bundle.instructions!.trim() }));

  for (const { scope, bundle } of ordered) {
    if (scope.level !== "org" && scope.level !== "tenant") continue;
    const where = scopeLabel(scope);
    if ((bundle.repos?.length ?? 0) > 0) {
      warnings.push(
        `broad grant: bundle "${bundle.name}" grants ${bundle.repos!.length} repo(s) at ${where} scope — every surface under it inherits them (incl. future/public surfaces). Bind repo grants to a domain or specific surface instead.`,
      );
    }
    if ((bundle.connections?.length ?? 0) > 0) {
      warnings.push(
        `broad grant: bundle "${bundle.name}" binds ${bundle.connections!.length} credential(s) at ${where} scope — their credentials are reachable from every surface under it. Bind sensitive credentials to a domain or specific surface instead.`,
      );
    }
    if ((bundle.connectors?.length ?? 0) > 0) {
      warnings.push(
        `broad grant: bundle "${bundle.name}" grants ${bundle.connectors!.length} connector(s) at ${where} scope — every surface under it may invoke those host-side connections with the credential each grant names. Bind connector grants to a domain or specific surface instead.`,
      );
    }
    if ((bundle.plugins?.length ?? 0) > 0) {
      warnings.push(
        `broad grant: bundle "${bundle.name}" grants ${bundle.plugins!.length} plugin(s) at ${where} scope — every surface under it gets those plugins' skills + connectors. Bind plugin grants to a domain or specific surface instead.`,
      );
    }
    if ((bundle.awsRoles?.length ?? 0) > 0) {
      warnings.push(
        `broad grant: bundle "${bundle.name}" grants ${bundle.awsRoles!.length} AWS role(s) at ${where} scope — every surface under it may assume those roles host-side. Bind AWS-role grants to a domain or specific surface instead.`,
      );
    }
  }

  const scopeKey =
    req.mode === "dm" && req.principalId
      ? `dm:${req.principalId}`
      : `${req.platform}/${req.workspace}/${req.channel}`;

  return {
    mode: req.mode,
    scopeKey,
    domains: req.domains ?? [],
    tenantKey: tenantKeyOf(req),
    surfaceKey: surfaceKeyOf(req),
    connections,
    reachableHosts,
    repos,
    repoCapabilities,
    resourceCapabilities,
    awsRoles,
    approvers,
    plugins,
    skills,
    subagents,
    connectors,
    connectorContentOrigin,
    connectorCredentials,
    instructionStack,
    preApprovalRules: preApprovalRules.rules,
    warnings,
  };
}
