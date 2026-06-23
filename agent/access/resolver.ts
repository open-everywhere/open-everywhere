import type { Bundle, Connection, HttpMethod, Plugin, Scope } from "./bundle.js";

export type SessionMode = "channel" | "dm" | "mpim";

export interface ResolveRequest {
  readonly mode: SessionMode;
  readonly platform: string;
  readonly workspace: string;
  readonly channel: string;
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
  readonly plugins: readonly Plugin[];
  readonly instructionStack: readonly InstructionLayer[];
  readonly warnings: readonly string[];
}

const SPECIFICITY: Record<Scope["level"], number> = { org: 0, workspace: 1, channel: 2 };

function scopeLabel(s: Scope): string {
  if (s.level === "org") return "org";
  if (s.level === "workspace") return `workspace:${s.workspace}`;
  return `channel:${s.workspace}/${s.channel}`;
}

function scopeMatches(s: Scope, req: ResolveRequest): boolean {
  switch (s.level) {
    case "org":
      return true;
    case "workspace":
      return s.workspace === req.workspace;
    case "channel":
      return s.workspace === req.workspace && s.channel === req.channel;
  }
}

function normHost(h: string): string {
  return h.trim().toLowerCase();
}

export function resolveAccess(req: ResolveRequest, bundles: readonly Bundle[]): EffectiveAccess {
  const warnings: string[] = [];

  const principalWorkspace = req.principalId ? `dm:${req.principalId}` : undefined;
  const applicable = bundles.filter((b) => {
    if (req.mode === "dm") {
      return principalWorkspace !== undefined && b.scope.workspace === principalWorkspace;
    }
    return scopeMatches(b.scope, req);
  });

  const ordered = [...applicable].sort(
    (a, b) => SPECIFICITY[a.scope.level] - SPECIFICITY[b.scope.level],
  );

  const connById = new Map<string, Connection>();
  const connScopeLevel = new Map<string, number>();
  for (const b of ordered) {
    const seenHostsThisBundle = new Map<string, string>();
    for (const c of b.connections ?? []) {
      for (const h of c.allowedWebsites) {
        const key = normHost(h);
        const prior = seenHostsThisBundle.get(key);
        if (prior && prior !== c.id) {
          warnings.push(
            `bundle "${b.name}" has two connections (${prior}, ${c.id}) claiming host ${h}; resolution order within a scope is undefined`,
          );
        }
        seenHostsThisBundle.set(key, c.id);
      }
      connById.set(c.id, c);
      connScopeLevel.set(c.id, SPECIFICITY[b.scope.level]);
    }
  }
  const connections = [...connById.values()];

  const hostMap = new Map<string, ReachableHost>();
  for (const d of ordered.flatMap((b) => b.domains ?? [])) {
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

  const repos = [...new Set(ordered.flatMap((b) => b.repos ?? []))].sort();
  const pluginById = new Map<string, Plugin>();
  for (const p of ordered.flatMap((b) => b.plugins ?? [])) pluginById.set(p.id, p);
  const plugins = [...pluginById.values()];

  const instructionStack: InstructionLayer[] = ordered
    .filter((b) => b.instructions && b.instructions.trim().length > 0)
    .map((b) => ({ source: scopeLabel(b.scope), text: b.instructions!.trim() }));

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
    instructionStack,
    warnings,
  };
}
