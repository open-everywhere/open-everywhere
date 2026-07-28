import { windowTopologyEnabled } from "../access/capabilities.js";
import type { SessionMode } from "../access/resolver.js";
import type { Trust } from "../identity/binding.js";

export type DomainMatch = "org" | "public" | "dm";

export type WindowMode = "solo" | "unified";

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
  readonly title?: string;
  readonly channels?: readonly string[];
  readonly match?: DomainMatch;
  readonly memory?: string | readonly string[];
  readonly includeOrg?: "readonly" | "inherit";
  readonly bundle?: string;
  readonly nameDropWake?: boolean;
  readonly ambientSupervisor?: boolean;
  readonly awarenessWake?: boolean;
  readonly mode?: WindowMode;
  readonly engagementTier?: EngagementTier;
  readonly models?: ModelRoutes;
  readonly reasoningCeiling?: ModelReasoning;
  readonly statusVerbs?: readonly string[];
  readonly statusVerbsMode?: "extend" | "replace";
  readonly role?: string;
  readonly sandbox?: SandboxPreset;
  readonly admins?: readonly string[];
  readonly governance?: boolean;
  readonly reportChannel?: string;
  readonly requestorEntitlementChecks?: boolean;
  readonly governanceDelivery?: GovernanceDeliveryMode;
}

export type GovernanceDeliveryMode = "channel" | "dm-fallback";

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

export function windowedSupervisorEnabled(channelKey: string, domains: readonly Domain[]): boolean {
  if (!windowTopologyEnabled()) return false;
  return domainForChannel(channelKey, domains)?.ambientSupervisor === true;
}

export function windowedDomainFor(channelKey: string, domains: readonly Domain[]): Domain | undefined {
  if (!windowedSupervisorEnabled(channelKey, domains)) return undefined;
  return domainForChannel(channelKey, domains);
}

export function windowModeFor(channelKey: string, domains: readonly Domain[]): WindowMode {
  return domainForChannel(channelKey, domains)?.mode ?? "solo";
}

export function assertUnifiedDomainTrust(domains: readonly Domain[]): void {
  const bad: string[] = [];
  for (const d of domains) {
    if (d.mode === undefined) continue;
    const isPseudo = d.match !== undefined;
    if (isPseudo) {
      bad.push(
        `  "${d.name}" (match "${d.match}") must not set mode — a standing window is a TEAM-section feature, never a pseudo-domain (org=the "window everything" footgun; public/dm=external/personal surface)`,
      );
    }
    if (d.ambientSupervisor !== true) {
      bad.push(`  "${d.name}" sets mode "${d.mode}" but not ambientSupervisor — a window is a re-keyed ambient supervisor, so it REQUIRES ambientSupervisor: true`);
    }
  }
  if (bad.length > 0) {
    throw new Error(
      "open-everywhere: invalid standing-window topology configuration:\n" +
        bad.join("\n") +
        "\n(memory/domain.ts assertUnifiedDomainTrust).",
    );
  }
}

export const BINDING_TRUSTED_PLATFORMS: ReadonlySet<string> = new Set(["slack", "local"]);

export function assertWindowSourcesVouched(domains: readonly Domain[], vouched: readonly string[]): void {
  const vset = new Set(vouched);
  const trustEnv = (process.env.OE_TRUST ?? "").trim().toLowerCase() === "internal";
  const bad: string[] = [];
  for (const d of domains) {
    if (d.mode !== "unified") continue;
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

export const GOVERNANCE_CHANNEL_MAX = 20;

export function governanceDomains(domains: readonly Domain[]): Domain[] {
  return domains.filter((d) => d.governance === true);
}

export function isGovernanceChannel(channelKey: string, domains: readonly Domain[]): boolean {
  return domainForChannel(channelKey, domains)?.governance === true;
}

export function governanceChannelFor(domains: readonly Domain[], fallback?: string): string | undefined {
  const first = governanceDomains(domains)[0]?.channels?.[0];
  return first ?? fallback;
}

export function governanceDeliveryMode(domains: readonly Domain[]): GovernanceDeliveryMode {
  return criteriaDomain("org", domains)?.governanceDelivery === "dm-fallback" ? "dm-fallback" : "channel";
}

export function assertGovernanceDomains(domains: readonly Domain[], vouched: readonly string[]): void {
  const vset = new Set(vouched);
  const trustEnv = (process.env.OE_TRUST ?? "").trim().toLowerCase() === "internal";
  const bad: string[] = [];
  for (const d of domains) {
    if (d.governanceDelivery !== undefined && d.match !== "org") {
      bad.push(
        `  "${d.name}" sets governanceDelivery, but that is a single ORG-WIDE knob — move it to the "org" pseudo-domain (the { match: "org" } domain); there is deliberately no per-domain delivery policy`,
      );
    }
    if (d.governance !== true) continue;
    const channels = d.channels ?? [];
    if (d.match !== undefined || d.channels === undefined) {
      bad.push(`  "${d.name}" is governance but not an explicit channels domain — a governance venue must list concrete channels, never a match/pseudo-domain`);
    }
    if (!d.admins || d.admins.length === 0) {
      bad.push(`  "${d.name}" is governance but has an empty admins roster — a governance venue with no admins unlocks nothing (add the org's admin principal ids to its admins list)`);
    }
    if (channels.length > GOVERNANCE_CHANNEL_MAX) {
      bad.push(`  "${d.name}" is governance with ${channels.length} channels — that exceeds the ${GOVERNANCE_CHANNEL_MAX}-channel governance cap (a governance domain is a SMALL uniformly-privileged venue; split it or re-tag)`);
    }
    for (const ch of channels) {
      const segs = ch.split("/");
      const platform = segs[0] ?? "";
      if (BINDING_TRUSTED_PLATFORMS.has(platform)) continue;
      const workspaceKey = segs.slice(0, 2).join("/");
      if (!(vset.has(workspaceKey) || vset.has(ch) || trustEnv)) {
        bad.push(`  "${d.name}" is governance but its channel "${ch}" is not operator-vouched-internal — vouch it in agent/identity/trusted-surfaces.ts (add "${ch}" or its workspace "${workspaceKey}"), or set OE_TRUST=internal for an internal-only deploy`);
      }
    }
  }
  if (bad.length > 0) {
    throw new Error(
      "open-everywhere: invalid governance domain(s):\n" +
        bad.join("\n") +
        "\n(memory/domain.ts assertGovernanceDomains).",
    );
  }
}

export function reportChannelFor(channelKey: string, domains: readonly Domain[]): string | undefined {
  return domainForChannel(channelKey, domains)?.reportChannel;
}

export function assertReportChannels(domains: readonly Domain[]): void {
  const bad: string[] = [];
  for (const d of domains) {
    const rc = d.reportChannel;
    if (rc === undefined) continue;
    if (d.channels === undefined || d.match !== undefined) {
      bad.push(`  "${d.name}" sets reportChannel but is not an explicit channels domain — a report redirect must name a concrete room inside a concrete domain, never a match/pseudo-domain`);
      continue;
    }
    if (!d.channels.includes(rc)) {
      bad.push(`  "${d.name}" sets reportChannel "${rc}", which is not one of its own channels — a routine may only be redirected INSIDE its domain (add "${rc}" to "${d.name}".channels, or point reportChannel at one of: ${d.channels.join(", ")})`);
    }
  }
  if (bad.length > 0) {
    throw new Error("open-everywhere: invalid domain reportChannel(s):\n" + bad.join("\n") + "\n(memory/domain.ts assertReportChannels — OPE-148).");
  }
}

export function requestorEntitlementChecksEnabled(domains: readonly Domain[]): boolean {
  return criteriaDomain("org", domains)?.requestorEntitlementChecks === true;
}

export function assertComplianceDomains(domains: readonly Domain[]): void {
  const bad = domains
    .filter((d) => d.requestorEntitlementChecks !== undefined && d.match !== "org")
    .map(
      (d) =>
        `  "${d.name}" sets requestorEntitlementChecks — that is an ORG-LEVEL compliance opt-in and ` +
        `belongs on the \`org\` pseudo-domain (match: "org"), never on a room/criteria domain ` +
        `(a per-room requestor pre-check is the per-user-answers-inside-a-room shape the design rejected)`,
    );
  if (bad.length > 0) {
    throw new Error(
      "open-everywhere: invalid compliance-mode config:\n" +
        bad.join("\n") +
        "\n(memory/domain.ts assertComplianceDomains).",
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
