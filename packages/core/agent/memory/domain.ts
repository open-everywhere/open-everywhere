import type { SessionMode } from "../access/resolver.js";
import type { Trust } from "../identity/binding.js";

export type DomainMatch = "org" | "public" | "dm";

export type EngagementTier = "aggressive" | "neutral" | "reserved";

export type ModelReasoning =
  | "provider-default"
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export type ModelTier = "high" | "medium" | "low";

export interface ModelRoute {
  readonly id?: string;
  readonly providers?: readonly string[];
  readonly reasoning?: ModelReasoning;
  readonly tier?: ModelTier;
}

export interface ModelRoutes {
  readonly primary?: ModelRoute;
  readonly utility?: ModelRoute;
  readonly supervisor?: ModelRoute;
}

export type ModelRole = keyof ModelRoutes;

export interface SandboxPreset {
  readonly vcpus?: number;
}

export interface Domain {
  readonly name: string;
  readonly channels?: readonly string[];
  readonly match?: DomainMatch;
  readonly memory?: string | readonly string[];
  readonly includeOrg?: "readonly" | "inherit";
  readonly bundle?: string;
  readonly nameDropWake?: boolean;
  readonly ambientSupervisor?: boolean;
  readonly awarenessWake?: boolean;
  readonly unifiedSupervisor?: boolean;
  readonly unifiedSupervisorGate?: boolean;
  readonly crossSurfaceWindow?: boolean;
  readonly crossSurfaceWindowGate?: boolean;
  readonly soloWindow?: boolean;
  readonly soloWindowGate?: boolean;
  readonly engagementTier?: EngagementTier;
  readonly models?: ModelRoutes;
  readonly reasoningCeiling?: ModelReasoning;
  readonly statusVerbs?: readonly string[];
  readonly statusVerbsMode?: "extend" | "replace";
  readonly role?: string;
  readonly sandbox?: SandboxPreset;
  readonly admins?: readonly string[];
}

export function memoryRefs(domain: Domain): string[] {
  if (!domain.memory) return [];
  return Array.isArray(domain.memory) ? [...domain.memory] : [domain.memory as string];
}

export function defineDomain(domain: Domain): Domain {
  return domain;
}

export function domainForChannel(channelKey: string, domains: readonly Domain[]): Domain | undefined {
  return domains.find((d) => d.channels?.includes(channelKey));
}

export function criteriaDomain(match: DomainMatch, domains: readonly Domain[]): Domain | undefined {
  return domains.find((d) => d.match === match);
}

export function domainMatchFor(mode: SessionMode, trust: Trust): DomainMatch | undefined {
  if (mode === "mpim") return undefined;
  if (mode === "dm") return trust === "internal" ? "dm" : "public";
  if (trust === "external") return "public";
  return undefined;
}

export function nameDropWakeEnabled(channelKey: string, domains: readonly Domain[]): boolean {
  const explicit = domainForChannel(channelKey, domains);
  if (explicit) return explicit.nameDropWake === true;
  return criteriaDomain("org", domains)?.nameDropWake === true;
}

export function ambientSupervisorEnabled(channelKey: string, domains: readonly Domain[]): boolean {
  const explicit = domainForChannel(channelKey, domains);
  if (explicit) return explicit.ambientSupervisor === true;
  return criteriaDomain("org", domains)?.ambientSupervisor === true;
}

export function awarenessWakeEnabled(channelKey: string, domains: readonly Domain[]): boolean {
  const explicit = domainForChannel(channelKey, domains);
  if (explicit) return explicit.awarenessWake === true;
  return criteriaDomain("org", domains)?.awarenessWake === true;
}

export function unifiedSupervisorOrgGateEnabled(domains: readonly Domain[]): boolean {
  const env = (process.env.OE_UNIFIED_SUPERVISOR ?? "").trim().toLowerCase();
  if (env === "1" || env === "true" || env === "yes" || env === "on") return true;
  return criteriaDomain("org", domains)?.unifiedSupervisorGate === true;
}

export function unifiedSupervisorEnabled(channelKey: string, domains: readonly Domain[]): boolean {
  if (!unifiedSupervisorOrgGateEnabled(domains)) return false;
  const explicit = domainForChannel(channelKey, domains);
  return explicit?.unifiedSupervisor === true && explicit?.ambientSupervisor === true;
}

export function unifiedDomainFor(channelKey: string, domains: readonly Domain[]): Domain | undefined {
  if (!unifiedSupervisorEnabled(channelKey, domains)) return undefined;
  return domainForChannel(channelKey, domains);
}

export function crossSurfaceWindowOrgGateEnabled(domains: readonly Domain[]): boolean {
  const env = (process.env.OE_CROSS_SURFACE_WINDOW ?? "").trim().toLowerCase();
  if (env === "1" || env === "true" || env === "yes" || env === "on") return true;
  return criteriaDomain("org", domains)?.crossSurfaceWindowGate === true;
}

export function crossSurfaceWindowEnabled(channelKey: string, domains: readonly Domain[]): boolean {
  if (!crossSurfaceWindowOrgGateEnabled(domains)) return false;
  if (!unifiedSupervisorEnabled(channelKey, domains)) return false;
  return domainForChannel(channelKey, domains)?.crossSurfaceWindow === true;
}

export function soloWindowOrgGateEnabled(domains: readonly Domain[]): boolean {
  const env = (process.env.OE_SOLO_WINDOW ?? "").trim().toLowerCase();
  if (env === "1" || env === "true" || env === "yes" || env === "on") return true;
  return criteriaDomain("org", domains)?.soloWindowGate === true;
}

export function soloWindowEnabled(channelKey: string, domains: readonly Domain[]): boolean {
  if (!soloWindowOrgGateEnabled(domains)) return false;
  if (!unifiedSupervisorEnabled(channelKey, domains)) return false;
  return domainForChannel(channelKey, domains)?.soloWindow === true;
}

export function assertUnifiedDomainTrust(domains: readonly Domain[]): void {
  const bad: string[] = [];
  for (const d of domains) {
    const isPseudo = d.match !== undefined;
    if (d.unifiedSupervisor === true) {
      if (isPseudo) {
        bad.push(
          `  "${d.name}" (match "${d.match}") must not set unifiedSupervisor — the unified supervisor is a TEAM-section feature, never a pseudo-domain (org=the "unify everything" footgun; public/dm=external/personal surface)`,
        );
      }
      if (d.ambientSupervisor !== true) {
        bad.push(`  "${d.name}" sets unifiedSupervisor but not ambientSupervisor — a unified session is a re-keyed ambient supervisor, so it REQUIRES ambientSupervisor: true`);
      }
    }
    if (d.unifiedSupervisorGate === true && d.match !== "org") {
      bad.push(
        `  "${d.name}" sets unifiedSupervisorGate but is not the { match: "org" } pseudo-domain — the gate is the ORG master switch; set it on the org domain (or use env OE_UNIFIED_SUPERVISOR=1), never on ${isPseudo ? `the "${d.match}" pseudo-domain` : "an explicit domain"}`,
      );
    }
    if (d.crossSurfaceWindow === true) {
      if (isPseudo) {
        bad.push(
          `  "${d.name}" (match "${d.match}") must not set crossSurfaceWindow — the single-context window is a TEAM-section feature, never a pseudo-domain (same footgun as unifiedSupervisor)`,
        );
      }
      if (d.unifiedSupervisor !== true) {
        bad.push(
          `  "${d.name}" sets crossSurfaceWindow but not unifiedSupervisor — the single-context window is a delivery mode OF the unified supervisor, so it REQUIRES unifiedSupervisor: true`,
        );
      }
    }
    if (d.crossSurfaceWindowGate === true && d.match !== "org") {
      bad.push(
        `  "${d.name}" sets crossSurfaceWindowGate but is not the { match: "org" } pseudo-domain — the gate is the ORG master switch; set it on the org domain (or use env OE_CROSS_SURFACE_WINDOW=1), never on ${isPseudo ? `the "${d.match}" pseudo-domain` : "an explicit domain"}`,
      );
    }
    if (d.soloWindow === true) {
      if (isPseudo) {
        bad.push(
          `  "${d.name}" (match "${d.match}") must not set soloWindow — the solo single-context window is a TEAM-section feature, never a pseudo-domain (same footgun as unifiedSupervisor)`,
        );
      }
      if (d.unifiedSupervisor !== true) {
        bad.push(
          `  "${d.name}" sets soloWindow but not unifiedSupervisor — the solo single-context window is a delivery mode OF the unified supervisor, so it REQUIRES unifiedSupervisor: true`,
        );
      }
    }
    if (d.soloWindowGate === true && d.match !== "org") {
      bad.push(
        `  "${d.name}" sets soloWindowGate but is not the { match: "org" } pseudo-domain — the gate is the ORG master switch; set it on the org domain (or use env OE_SOLO_WINDOW=1), never on ${isPseudo ? `the "${d.match}" pseudo-domain` : "an explicit domain"}`,
      );
    }
  }
  if (bad.length > 0) {
    throw new Error(
      "open-everywhere: invalid unified cross-surface supervisor configuration:\n" +
        bad.join("\n") +
        "\n(memory/domain.ts assertUnifiedDomainTrust).",
    );
  }
}

const BINDING_TRUSTED_PLATFORMS: ReadonlySet<string> = new Set(["slack", "local"]);

export function assertWindowSourcesVouched(domains: readonly Domain[], vouched: readonly string[]): void {
  const vset = new Set(vouched);
  const trustEnv = (process.env.OE_TRUST ?? "").trim().toLowerCase() === "internal";
  const bad: string[] = [];
  for (const d of domains) {
    if (d.crossSurfaceWindow !== true) continue;
    const channels = d.channels ?? [];
    if (channels.length <= 1) continue;
    for (const ch of channels) {
      const segs = ch.split("/");
      const platform = segs[0] ?? "";
      if (BINDING_TRUSTED_PLATFORMS.has(platform)) continue;
      const workspaceKey = segs.slice(0, 2).join("/");
      const okay = vset.has(workspaceKey) || vset.has(ch) || trustEnv;
      if (!okay) {
        bad.push(
          `  domain "${d.name}" includes UN-vouched source "${ch}" in a multi-source (${channels.length}-channel) cross-surface window — vouch it in agent/identity/trusted-surfaces.ts (add "${ch}" or its workspace "${workspaceKey}"), or set OE_TRUST=internal for an internal-only deploy`,
        );
      }
    }
  }
  if (bad.length > 0) {
    throw new Error(
      "open-everywhere: multi-source cross-surface window has un-vouched source(s):\n" +
        bad.join("\n") +
        "\n(memory/domain.ts assertWindowSourcesVouched).",
    );
  }
}

const PLATFORM_ENGAGEMENT_TIER_DEFAULTS: Readonly<Record<string, EngagementTier>> = {
  github: "reserved",
};

export function engagementTierFor(channelKey: string, domains: readonly Domain[]): EngagementTier {
  const explicit = domainForChannel(channelKey, domains)?.engagementTier;
  if (explicit) return explicit;
  const org = criteriaDomain("org", domains)?.engagementTier;
  if (org) return org;
  const platform = channelKey.split("/")[0] ?? "";
  return PLATFORM_ENGAGEMENT_TIER_DEFAULTS[platform] ?? "neutral";
}

interface KnobLayer {
  readonly statusVerbs?: readonly string[];
  readonly statusVerbsMode?: "extend" | "replace";
  readonly models?: ModelRoutes;
  readonly reasoningCeiling?: ModelReasoning;
}

export interface NamedKnobLayer extends KnobLayer {
  readonly name: string;
}

function knobLayersForDomain(
  domains: readonly Domain[],
  roles: readonly NamedKnobLayer[],
  target: Domain | undefined,
  surfaceMatch?: DomainMatch,
): KnobLayer[] {
  const layers: KnobLayer[] = [];
  const rungs: (Domain | undefined)[] = [criteriaDomain("org", domains)];
  if (surfaceMatch === "dm" || surfaceMatch === "public") {
    rungs.push(criteriaDomain(surfaceMatch, domains));
  }
  rungs.push(target);
  for (const d of rungs) {
    if (!d) continue;
    const role = d.role !== undefined ? roles.find((r) => r.name === d.role) : undefined;
    if (role) layers.push(role);
    layers.push(d);
  }
  return layers;
}

function knobLayersFor(
  channelKey: string,
  domains: readonly Domain[],
  roles: readonly NamedKnobLayer[],
  surfaceMatch?: DomainMatch,
): KnobLayer[] {
  return knobLayersForDomain(domains, roles, domainForChannel(channelKey, domains), surfaceMatch);
}

export function modelRouteFor(
  role: ModelRole,
  channelKey: string,
  domains: readonly Domain[],
  roles: readonly NamedKnobLayer[] = [],
  surfaceMatch?: DomainMatch,
): ModelRoute {
  const layers = knobLayersFor(channelKey, domains, roles, surfaceMatch);
  let route: ModelRoute = {};
  for (const d of layers) {
    const r = d?.models?.[role];
    if (!r) continue;
    route = {
      id: r.id !== undefined ? r.id : r.tier !== undefined ? undefined : route.id,
      tier: r.tier !== undefined ? r.tier : r.id !== undefined ? undefined : route.tier,
      providers: r.providers ?? (r.id !== undefined && r.id !== route.id ? undefined : route.providers),
      reasoning: r.reasoning ?? route.reasoning,
    };
  }
  return route;
}

export const DEFAULT_STATUS_VERBS: readonly string[] = [
  "Tinkering",
  "Untangling",
  "Sifting",
  "Weaving",
  "Whittling",
  "Rummaging",
  "Distilling",
  "Plotting",
  "Doodling",
  "Juggling",
];

export function statusVerbsFor(
  channelKey: string,
  domains: readonly Domain[],
  roles: readonly NamedKnobLayer[] = [],
  surfaceMatch?: DomainMatch,
): readonly string[] {
  const layers = knobLayersFor(channelKey, domains, roles, surfaceMatch);
  let verbs = [...DEFAULT_STATUS_VERBS];
  for (const d of layers) {
    const own = (d?.statusVerbs ?? []).map((v) => v.trim()).filter((v) => v.length > 0);
    if (own.length === 0 && d?.statusVerbsMode !== "replace") continue;
    verbs = d?.statusVerbsMode === "replace" ? own : [...verbs, ...own.filter((v) => !verbs.includes(v))];
  }
  return verbs.length > 0 ? verbs : DEFAULT_STATUS_VERBS;
}

export function reasoningCeilingFor(
  channelKey: string,
  domains: readonly Domain[],
  roles: readonly NamedKnobLayer[] = [],
  surfaceMatch: DomainMatch | undefined,
  base: ModelReasoning,
): ModelReasoning {
  let ceiling = base;
  for (const d of knobLayersFor(channelKey, domains, roles, surfaceMatch)) {
    if (d?.reasoningCeiling !== undefined) ceiling = d.reasoningCeiling;
  }
  return ceiling;
}

export function reasoningCeilingForDomain(
  domainName: string,
  domains: readonly Domain[],
  roles: readonly NamedKnobLayer[] = [],
  base: ModelReasoning,
): ModelReasoning {
  const target = domains.find((d) => d.name === domainName);
  let ceiling = base;
  for (const d of knobLayersForDomain(domains, roles, target, undefined)) {
    if (d?.reasoningCeiling !== undefined) ceiling = d.reasoningCeiling;
  }
  return ceiling;
}

export function assertChannelExclusivity(domains: readonly Domain[]): void {
  const owner = new Map<string, string>();
  const clashes: string[] = [];
  for (const d of domains) {
    for (const ch of d.channels ?? []) {
      const prev = owner.get(ch);
      if (prev !== undefined && prev !== d.name) {
        clashes.push(`  "${ch}" is in both "${prev}" and "${d.name}"`);
      } else {
        owner.set(ch, d.name);
      }
    }
  }
  if (clashes.length > 0) {
    throw new Error(
      "open-everywhere: a channel may belong to at most one memory domain, but:\n" +
        clashes.join("\n") +
        "\nRemove the channel from all but one domain (docs/capabilities/memory.md).",
    );
  }
}

export function assertDomainsValid(domains: readonly Domain[]): void {
  const bad: string[] = [];
  const byMatch = new Map<DomainMatch, string>();
  let hasOrg = false;
  for (const d of domains) {
    const hasChannels = d.channels !== undefined;
    const hasMatch = d.match !== undefined;
    if (hasChannels === hasMatch) {
      bad.push(`  "${d.name}" must have EITHER channels (explicit) OR match (criteria), not ${hasChannels ? "both" : "neither"}`);
    }
    if (hasMatch) {
      if (d.match === "org") hasOrg = true;
      const prev = byMatch.get(d.match!);
      if (prev) bad.push(`  match "${d.match}" is claimed by both "${prev}" and "${d.name}" (at most one per match value)`);
      else byMatch.set(d.match!, d.name);
      if (d.includeOrg && (d.match === "org" || d.match === "public")) {
        bad.push(`  "${d.name}" (match "${d.match}") must not set includeOrg (${d.match === "org" ? "self-reference" : "would leak org memory to the external surface"})`);
      }
    }
  }
  for (const d of domains) {
    if (d.includeOrg && !hasOrg) {
      bad.push(`  "${d.name}" sets includeOrg but no { match: "org" } domain is defined to include`);
    }
  }
  if (bad.length > 0) {
    throw new Error(
      "open-everywhere: invalid memory domain(s):\n" + bad.join("\n") + "\n(memory/domain.ts / docs/capabilities/memory.md)",
    );
  }
}
