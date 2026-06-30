import type { Binding, Bundle, Connection, HttpMethod, Scope } from "./bundle.js";
import type { PluginRegistry } from "../plugins/types.js";
import { expandProviderGrant, type Provider, type ResolvedConnectorCredential } from "./providers.js";

export type SessionMode = "channel" | "dm" | "mpim";

export interface ResolveRequest {
  readonly mode: SessionMode;
  readonly platform: string;
  readonly workspace: string;
  readonly channel: string;
  readonly domains?: readonly string[];
  readonly principalId?: string;
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
  readonly connections: readonly Connection[];
  readonly reachableHosts: readonly ReachableHost[];
  readonly repos: readonly string[];
  readonly plugins: readonly string[];
  readonly skills: readonly string[];
  readonly subagents: readonly string[];
  readonly connectors: readonly string[];
  readonly connectorCredentials: Readonly<Record<string, ResolvedConnectorCredential>>;
  readonly instructionStack: readonly InstructionLayer[];
  readonly warnings: readonly string[];
}

const SPECIFICITY: Record<Scope["level"], number> = { org: 0, workspace: 1, domain: 2, channel: 3 };

function scopeLabel(s: Scope): string {
  if (s.level === "org") return "org";
  if (s.level === "workspace") return `workspace:${s.workspace}`;
  if (s.level === "domain") return `domain:${s.workspace}/${s.domain}`;
  return `channel:${s.workspace}/${s.channel}`;
}

function scopeMatches(s: Scope, req: ResolveRequest): boolean {
  switch (s.level) {
    case "org":
      return true;
    case "workspace":
      return s.workspace === req.workspace;
    case "domain":
      return s.workspace === req.workspace && (req.domains?.includes(s.domain!) ?? false);
    case "channel":
      return s.workspace === req.workspace && s.channel === req.channel;
  }
}

function normHost(h: string): string {
  return h.trim().toLowerCase();
}

export function resolveAccess(
  req: ResolveRequest,
  bundles: readonly Bundle[],
  bindings: readonly Binding[],
  registry: PluginRegistry = {},
  providers: readonly Provider[] = [],
): EffectiveAccess {
  const warnings: string[] = [];
  const byName = new Map(bundles.map((b) => [b.name, b]));

  const principalWorkspace = req.principalId ? `dm:${req.principalId}` : undefined;

  const applied: { scope: Scope; bundle: Bundle }[] = [];
  for (const binding of bindings) {
    const inScope =
      req.mode === "dm"
        ? principalWorkspace !== undefined && binding.scope.workspace === principalWorkspace
        : scopeMatches(binding.scope, req);
    if (!inScope) continue;
    const bundle = byName.get(binding.bundle);
    if (!bundle) {
      warnings.push(`binding references unknown bundle "${binding.bundle}" — ignored`);
      continue;
    }
    applied.push({ scope: binding.scope, bundle });
  }

  const ordered = [...applied].sort(
    (a, b) => SPECIFICITY[a.scope.level] - SPECIFICITY[b.scope.level],
  );

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

  const repos = [...new Set(ordered.flatMap(({ bundle }) => bundle.repos ?? []))].sort();

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
  const providerByName = new Map(providers.map((p) => [p.name, p]));
  const connectorCredentials: Record<string, ResolvedConnectorCredential> = {};
  const providerConnectors = new Set<string>();
  for (const { bundle } of ordered) {
    for (const grant of bundle.providers ?? []) {
      const { resolved, warnings: gw } = expandProviderGrant(grant, providerByName.get(grant.provider), {
        dm: req.mode === "dm",
      });
      for (const w of gw) warnings.push(`bundle "${bundle.name}": ${w}`);
      for (const rc of resolved) {
        providerConnectors.add(rc.connection);
        connectorCredentials[rc.connection] = rc;
      }
    }
  }

  const connectors = [
    ...new Set([
      ...ordered.flatMap(({ bundle }) => bundle.connectors ?? []),
      ...pluginConnectors,
      ...providerConnectors,
    ]),
  ].sort();

  const instructionStack: InstructionLayer[] = ordered
    .filter(({ bundle }) => bundle.instructions && bundle.instructions.trim().length > 0)
    .map(({ scope, bundle }) => ({ source: scopeLabel(scope), text: bundle.instructions!.trim() }));

  for (const { scope, bundle } of ordered) {
    if (scope.level === "channel" || scope.level === "domain") continue;
    if (scope.workspace?.startsWith("dm:")) continue;
    const where = scopeLabel(scope);
    if ((bundle.repos?.length ?? 0) > 0) {
      warnings.push(
        `broad grant: bundle "${bundle.name}" grants ${bundle.repos!.length} repo(s) at ${where} scope — every channel under it inherits them (incl. future/public channels). Bind repo grants to a domain or specific channel instead.`,
      );
    }
    if ((bundle.connections?.length ?? 0) > 0) {
      warnings.push(
        `broad grant: bundle "${bundle.name}" binds ${bundle.connections!.length} credential(s) at ${where} scope — their credentials are reachable from every channel under it. Bind sensitive credentials to a domain or specific channel instead.`,
      );
    }
    if ((bundle.connectors?.length ?? 0) > 0) {
      warnings.push(
        `broad grant: bundle "${bundle.name}" grants ${bundle.connectors!.length} connector(s) at ${where} scope — every channel under it may invoke those host-side connections. Bind connector grants to a domain or specific channel instead.`,
      );
    }
    if ((bundle.providers?.length ?? 0) > 0) {
      warnings.push(
        `broad grant: bundle "${bundle.name}" grants ${bundle.providers!.length} provider credential(s) at ${where} scope — every channel under it authenticates to those providers with that credential. Bind provider grants to a domain or specific channel instead.`,
      );
    }
    if ((bundle.plugins?.length ?? 0) > 0) {
      warnings.push(
        `broad grant: bundle "${bundle.name}" grants ${bundle.plugins!.length} plugin(s) at ${where} scope — every channel under it gets those plugins' skills + connectors. Bind plugin grants to a domain or specific channel instead.`,
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
    connections,
    reachableHosts,
    repos,
    plugins,
    skills,
    subagents,
    connectors,
    connectorCredentials,
    instructionStack,
    warnings,
  };
}
