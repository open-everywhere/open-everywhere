import { windowTopologyEnabled } from "../access/capabilities.js";
import { isQualifiedPrincipalKey } from "../identity/principal-key.js";
import { tenantRungRemedy } from "../access/tenant-admission.js";
import { DM_ANCHOR_DOMAIN_PREFIX } from "../channels/window-key.js";
import type { SessionMode } from "../access/resolver.js";
import type { Trust } from "../identity/binding.js";
import type { ApprovalModeConfig } from "../access/approver-chain.js";

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
  readonly containers?: readonly string[];
  readonly excludeContainers?: readonly string[];
  readonly match?: DomainMatch;
  readonly memory?: string | readonly string[];
  readonly includeOrg?: "readonly" | "inherit";
  readonly approvalMode?: ApprovalModeConfig;
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

export type DomainVia = "roster" | `container:${string}` | `excluded:${string}` | "none";

export interface DomainRouting {
  readonly domain: Domain | undefined;
  readonly via: DomainVia;
}

type ContainerEntry =
  | { readonly kind: "tenant"; readonly platform: string; readonly tenant: string }
  | { readonly kind: "surface"; readonly platform: string; readonly tenant: string; readonly prefix: string; readonly glob: boolean };

function parseContainerEntry(entry: string): ContainerEntry | undefined {
  const segs = entry.split("/");
  const [platform, tenant, surface] = segs;
  if (!platform || !tenant || platform.includes("*") || tenant.includes("*")) return undefined;
  if (segs.length === 2) return { kind: "tenant", platform, tenant };
  if (segs.length !== 3 || surface === undefined) return undefined;
  const star = surface.indexOf("*");
  if (star === -1) return surface === "" ? undefined : { kind: "surface", platform, tenant, prefix: surface, glob: false };
  if (star !== surface.length - 1) return undefined;
  return { kind: "surface", platform, tenant, prefix: surface.slice(0, -1), glob: true };
}

function entryMatchesKey(e: ContainerEntry, channelKey: string): boolean {
  const segs = channelKey.split("/");
  if (segs[0] !== e.platform || segs[1] !== e.tenant) return false;
  if (e.kind === "tenant") return true;
  if (segs.length !== 3) return false;
  const surface = segs[2] ?? "";
  return e.glob ? surface.startsWith(e.prefix) : surface === e.prefix;
}

function firstMatching(entries: readonly string[] | undefined, channelKey: string): string | undefined {
  for (const entry of entries ?? []) {
    const parsed = parseContainerEntry(entry);
    if (parsed && entryMatchesKey(parsed, channelKey)) return entry;
  }
  return undefined;
}

export function domainClaimVerdict(
  domain: Domain,
  channelKey: string,
): { readonly kind: "admits" | "excluded"; readonly entry: string } | undefined {
  const admits = firstMatching(domain.containers, channelKey);
  if (admits === undefined) return undefined;
  const excluded = firstMatching(domain.excludeContainers, channelKey);
  return excluded === undefined ? { kind: "admits", entry: admits } : { kind: "excluded", entry: excluded };
}

export function resolveDomainForChannel(channelKey: string, domains: readonly Domain[]): DomainRouting {
  const roster = domains.find((d) => d.channels?.includes(channelKey));
  if (roster) return { domain: roster, via: "roster" };
  let vetoed: DomainVia | undefined;
  for (const d of domains) {
    const verdict = domainClaimVerdict(d, channelKey);
    if (!verdict) continue;
    if (verdict.kind === "admits") return { domain: d, via: `container:${verdict.entry}` };
    vetoed ??= `excluded:${d.name}:${verdict.entry}`;
  }
  return { domain: undefined, via: vetoed ?? "none" };
}

export function domainForChannel(channelKey: string, domains: readonly Domain[]): Domain | undefined {
  return resolveDomainForChannel(channelKey, domains).domain;
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

export type AmbientSkip = "no-domain" | "domain-refused";

export function ambientSkipFor(
  channelKey: string,
  domains: readonly Domain[],
): { readonly reason: AmbientSkip; readonly domain?: string; readonly via: DomainVia } | undefined {
  const routing = resolveDomainForChannel(channelKey, domains);
  if (routing.domain) {
    if (routing.domain.ambientSupervisor === true) return undefined;
    return { reason: "domain-refused", domain: routing.domain.name, via: routing.via };
  }
  if (criteriaDomain("org", domains)?.ambientSupervisor === true) return undefined;
  return { reason: "no-domain", via: routing.via };
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
          `  domain "${d.name}" includes UN-vouched source "${ch}" in a multi-source (${channels.length}-channel) cross-surface window — vouch it in agent/identity/surfaces.ts (add "${ch}" or its workspace "${workspaceKey}"), or set OE_TRUST=internal for an internal-only deploy`,
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
    if (d.containers !== undefined) {
      bad.push(`  "${d.name}" is governance but claims container(s) [${d.containers.join(", ")}] — a governance venue is a SMALL, enumerated, individually-vouched audience, and neither the ${GOVERNANCE_CHANNEL_MAX}-channel cap nor the per-channel vouch can be decided over an unbounded claim, whether it is a whole tenant or a \`prefix*\` glob (list the concrete channels, or drop governance from this domain)`);
    }
    if (d.excludeContainers !== undefined) {
      bad.push(`  "${d.name}" is governance but sets excludeContainers [${d.excludeContainers.join(", ")}] — an exclusion carves surfaces out of a CLAIM, and a governance venue may not claim at all; its audience is the enumerated \`channels\` roster and nothing else (drop excludeContainers)`);
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
        bad.push(`  "${d.name}" is governance but its channel "${ch}" is not operator-vouched-internal — vouch it in agent/identity/surfaces.ts (add "${ch}" or its workspace "${workspaceKey}"), or set OE_TRUST=internal for an internal-only deploy`);
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

function entriesIntersect(a: ContainerEntry, b: ContainerEntry): boolean {
  if (a.platform !== b.platform || a.tenant !== b.tenant) return false;
  if (a.kind === "tenant" || b.kind === "tenant") return true;
  if (a.glob && b.glob) return a.prefix.startsWith(b.prefix) || b.prefix.startsWith(a.prefix);
  if (a.glob) return b.prefix.startsWith(a.prefix);
  if (b.glob) return a.prefix.startsWith(b.prefix);
  return a.prefix === b.prefix;
}

function entryContains(outer: ContainerEntry, inner: ContainerEntry): boolean {
  if (outer.platform !== inner.platform || outer.tenant !== inner.tenant) return false;
  if (outer.kind === "tenant") return true;
  if (inner.kind === "tenant") return false;
  if (!outer.glob) return !inner.glob && inner.prefix === outer.prefix;
  return inner.prefix.startsWith(outer.prefix);
}

function exclusionCovering(domain: Domain, set: ContainerEntry): string | undefined {
  for (const entry of domain.excludeContainers ?? []) {
    const parsed = parseContainerEntry(entry);
    if (parsed && entryContains(parsed, set)) return entry;
  }
  return undefined;
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
  const claims = domains.map((d) => ({
    domain: d,
    entries: (d.containers ?? []).flatMap((entry) => {
      const parsed = parseContainerEntry(entry);
      return parsed ? [{ entry, parsed }] : [];
    }),
  }));
  for (const { domain: d, entries } of claims) {
    for (const { entry } of entries) {
      const roster = owner.get(entry);
      if (roster !== undefined) {
        clashes.push(
          `  "${entry}" is claimed as a container by "${d.name}" but is also a channels entry of "${roster}" — a roster entry and a tenant claim are different things; say which you meant`,
        );
      }
    }
  }
  for (let i = 0; i < claims.length; i++) {
    for (let j = i + 1; j < claims.length; j++) {
      const a = claims[i]!;
      const b = claims[j]!;
      if (a.domain.name === b.domain.name) continue;
      for (const ae of a.entries) {
        for (const be of b.entries) {
          if (!entriesIntersect(ae.parsed, be.parsed)) continue;
          const overlap = entryContains(ae.parsed, be.parsed) ? be.parsed : ae.parsed;
          if (exclusionCovering(a.domain, overlap) !== undefined) continue;
          if (exclusionCovering(b.domain, overlap) !== undefined) continue;
          const overlapText = entryContains(ae.parsed, be.parsed) ? be.entry : ae.entry;
          clashes.push(
            ae.entry === be.entry && ae.parsed.kind === "tenant"
              ? `  the tenant "${ae.entry}" is claimed in containers by both "${a.domain.name}" and "${b.domain.name}"`
              : `  the containers entries "${ae.entry}" ("${a.domain.name}") and "${be.entry}" ("${b.domain.name}") can match the SAME surface key, so which domain owns it would depend on declaration order — narrow one of them, or add excludeContainers: ["${overlapText}"] to the domain that should NOT get the overlap`,
          );
        }
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
    if (d.name.startsWith(DM_ANCHOR_DOMAIN_PREFIX)) {
      bad.push(
        `  "${d.name}" starts with the RESERVED prefix "${DM_ANCHOR_DOMAIN_PREFIX}" — that namespace belongs to the DM delegation anchor (channels/window-key.ts dmAnchorDomain, OPE-306) and can never be a configured domain name. Rename it.`,
      );
    }
    const hasExplicit = d.channels !== undefined || d.containers !== undefined;
    const hasMatch = d.match !== undefined;
    if (hasExplicit === hasMatch) {
      bad.push(`  "${d.name}" must have EITHER explicit membership (channels and/or containers) OR match (criteria), not ${hasExplicit ? "both" : "neither"}`);
    }
    const claimEntries: { readonly entry: string; readonly parsed: ContainerEntry }[] = [];
    for (const key of d.containers ?? []) {
      const parsed = parseContainerEntry(key);
      if (parsed) {
        if (parsed.kind === "surface" && !parsed.glob) {
          bad.push(
            `  "${d.name}" claims container "${key}", which names ONE exact surface — that is a roster entry, so list it in \`channels\` instead (containers is the unbounded CLAIM tier: a two-segment tenant key \`platform/<tenant>\`, or a same-level glob \`platform/<tenant>/<prefix>*\`)`,
          );
          continue;
        }
        claimEntries.push({ entry: key, parsed });
        continue;
      }
      const segs = key.split("/");
      bad.push(
        segs.length > 3
          ? `  "${d.name}" claims container "${key}", but INTERMEDIATE containers are not supported — a containers entry is a two-segment tenant key \`platform/<tenant>\` (e.g. "github/acme", "linear/<orgId>", "notion/<workspaceId>") or a THREE-segment same-level glob \`platform/<tenant>/<prefix>*\` (e.g. "github/acme/payments-*"), never a deeper path. A deeper claim ("every row under this database") needs an ancestor walk the webhook payload cannot prove and an API call per level, so it is refused BY NAME rather than admitted with no reader. List the concrete surfaces in channels instead.`
          : `  "${d.name}" claims container "${key}", which is neither a two-segment tenant key \`platform/<tenant>\` (e.g. "github/acme", "linear/<orgId>", "notion/<workspaceId>") nor a same-level glob \`platform/<tenant>/<prefix>*\` (e.g. "github/acme/payments-*"). The glob is deliberately ONE trailing \`*\` on the LAST segment — never \`**\`, never mid-string, never in the platform or tenant segment, never a regex — because overlap between two entries has to be decidable at config load (assertChannelExclusivity), and an undecidable overlap is an at-most-one-domain hole.`,
      );
    }
    for (const key of d.excludeContainers ?? []) {
      const parsed = parseContainerEntry(key);
      if (!parsed || parsed.kind === "tenant") {
        bad.push(
          parsed
            ? `  "${d.name}" excludes "${key}", which is a WHOLE TENANT — an exclusion carves surfaces out of a claim, so it is a three-segment surface key ("github/acme/payments-secrets") or a same-level glob ("github/acme/payments-secret-*"). A tenant-wide exclusion either cancels the claim outright or means nothing; drop the containers entry instead.`
            : `  "${d.name}" excludes "${key}", which is not a surface key \`platform/<tenant>/<surface>\` nor a same-level glob \`platform/<tenant>/<prefix>*\` (one trailing \`*\` on the last segment only — see the containers rule)`,
        );
        continue;
      }
      const ownRoster = (d.channels ?? []).find((ch) => entryMatchesKey(parsed, ch));
      if (ownRoster !== undefined) {
        bad.push(
          `  "${d.name}" excludes "${key}" but also lists "${ownRoster}" in its own \`channels\` — exclusions carve out of the CLAIM tier only, and the roster wins regardless, so this is a contradiction: delete the channels entry, or the exclusion.`,
        );
      }
      const cancels = claimEntries.find((c) => entryContains(parsed, c.parsed));
      if (cancels) {
        bad.push(
          `  "${d.name}" excludes "${key}", which cancels the WHOLE of its containers entry "${cancels.entry}" — that pair is dead config (the claim can never admit anything). Delete both, or narrow the exclusion.`,
        );
        continue;
      }
      if (!claimEntries.some((c) => entriesIntersect(parsed, c.parsed))) {
        bad.push(
          `  "${d.name}" excludes "${key}", but none of its \`containers\` entries [${(d.containers ?? []).join(", ") || "<none>"}] can match it — a dead exclusion reads like a carve-out and grants everything it was meant to withhold. Fix the key, or drop it.`,
        );
      }
    }
    if (d.approvalMode !== undefined) {
      const mode = d.approvalMode.mode;
      if (mode !== "DANGEROUSLY_BYPASS" && mode !== "APPROVE_ALL" && mode !== "DENY_ALL") {
        bad.push(`  "${d.name}" sets approvalMode.mode "${String(mode)}" — must be DANGEROUSLY_BYPASS, APPROVE_ALL or DENY_ALL (access/approver-chain.ts)`);
      }
      if (d.approvalMode.allowlist !== undefined && mode !== "APPROVE_ALL") {
        bad.push(`  "${d.name}" sets approvalMode.allowlist under ${mode} — the allowlist is APPROVE_ALL's restoration list and means nothing on any other mode (remove it, or it reads as an escape hatch that does not exist)`);
      }
      if (d.approvalMode.allowlist?.some((t) => t.trim() === "")) {
        bad.push(`  "${d.name}" approvalMode.allowlist has an empty entry — every entry must name a tool`);
      }
    }
    for (const entry of d.admins ?? []) {
      if (isQualifiedPrincipalKey(entry)) continue;
      bad.push(
        `  "${d.name}" lists admin "${entry}", which is not a well-formed principal key \`platform/<principal-id>\` — or, on a tenant-scoped platform, \`platform/<tenant-id>/<principal-id>\` (e.g. "slack/T0AB1CD2E/U0EXUSER002", "discord/300000000000000104"). Admin standing is exact-id ONLY — static and diff-auditable, with no runtime link-set resolution on the highest-privilege gate. A bare vendor id names no namespace and can never match; a \`linkSet:<id>\` reference is deliberately refused here (use a \`principal\` credential binding or a person-group for link-set-keyed grants).${tenantRungRemedy(entry, domains)} (identity/principal-key.ts)`,
      );
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
