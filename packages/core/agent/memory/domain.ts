import { windowTopologyEnabled } from "../access/capabilities.js";
import { isQualifiedPrincipalKey } from "../identity/principal-key.js";
import {
  isGroupSegment,
  parseSurfaceKeyEntry,
  surfaceKeyEntriesEquivalent,
  surfaceKeyEntriesIntersect,
  surfaceKeyEntryContains,
  surfaceKeyEntryMatches,
  type SurfaceKeyEntry,
} from "../identity/surface-key-grammar.js";
import { tenantRungRemedy } from "../access/tenant-admission.js";
import { DM_ANCHOR_DOMAIN_PREFIX } from "../channels/window-key.js";
import { DEFAULT_ADMISSION, admissionFunctionNames, isAdmissionFunctionName } from "../channels/seat-admission.js";
import { credentialGrantDeclarationProblems } from "../access/credential-grant.js";
import { domainCredentialProblems, type DomainCredentialOverride } from "../access/domain-credentials.js";
import type { SessionMode } from "../access/resolver.js";
import type { Trust } from "../identity/binding.js";
import { getSettings, languageTagProblem } from "../settings/settings.js";
import { isVouchedInternal } from "../identity/trust.js";
import type { ApprovalModeConfig } from "../access/approver-chain.js";
import type { ExternalPolicyOverride, ExternalRoomGrain } from "../access/external-policy.js";

export type DomainMatch = "org" | "public" | "dm";

export type WindowMode = "solo" | "unified";

export interface WindowGroup {
  readonly name: string;
  readonly reach?: readonly string[];
  readonly exclude?: readonly string[];
}

export const WINDOW_GROUP_NAME_RE = /^(?=.{1,64}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;

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
  readonly reach?: readonly string[];
  readonly exclude?: readonly string[];
  readonly match?: DomainMatch;
  readonly memory?: string | readonly string[];
  readonly includeOrg?: "readonly" | "inherit";
  readonly memoryCanvas?: boolean;
  readonly approvalMode?: ApprovalModeConfig;
  readonly nameDropWake?: boolean;
  readonly ambientSupervisor?: boolean;
  readonly admission?: string;
  readonly externalPolicy?: ExternalPolicyOverride;
  readonly mode?: WindowMode;
  readonly windows?: readonly WindowGroup[];
  readonly engagementTier?: EngagementTier;
  readonly models?: ModelRoutes;
  readonly reasoningCeiling?: ModelReasoning;
  readonly statusVerbs?: readonly string[];
  readonly statusVerbsMode?: "extend" | "replace";
  readonly role?: string;
  readonly sandbox?: SandboxPreset;
  readonly language?: string;
  readonly admins?: readonly string[];
  readonly governance?: boolean;
  readonly reportChannel?: string;
  readonly governanceDelivery?: GovernanceDeliveryMode;
  readonly credentials?: readonly DomainCredentialOverride[];

  readonly credentialGrants?: readonly string[];
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

type ReachEntry = SurfaceKeyEntry;

const parseReachEntry = parseSurfaceKeyEntry;

const entryMatchesKey = surfaceKeyEntryMatches;

const entryContains = surfaceKeyEntryContains;

interface ParsedEntry {
  readonly entry: string;
  readonly parsed: ReachEntry;
}

function parseEntries(entries: readonly string[] | undefined): ParsedEntry[] {
  const out: ParsedEntry[] = [];
  for (const entry of entries ?? []) {
    const parsed = parseReachEntry(entry);
    if (parsed) out.push({ entry, parsed });
  }
  return out;
}

function mostSpecificMatch(entries: readonly ParsedEntry[], channelKey: string): ParsedEntry | undefined {
  let best: ParsedEntry | undefined;
  for (const candidate of entries) {
    if (!entryMatchesKey(candidate.parsed, channelKey)) continue;
    if (best === undefined || entryContains(best.parsed, candidate.parsed)) {
      if (best !== undefined && surfaceKeyEntriesEquivalent(best.parsed, candidate.parsed)) continue;
      best = candidate;
    }
  }
  return best;
}

export function domainRoster(domain: { readonly reach?: readonly string[] }): string[] {
  const out: string[] = [];
  for (const entry of domain.reach ?? []) {
    const parsed = parseReachEntry(entry);
    if (parsed?.kind === "surface" && !parsed.glob) out.push(entry);
  }
  return out;
}

export function domainContainers(domain: { readonly reach?: readonly string[] }): string[] {
  const out: string[] = [];
  for (const entry of domain.reach ?? []) {
    const parsed = parseReachEntry(entry);
    if (parsed && (parsed.kind !== "surface" || parsed.glob)) out.push(entry);
  }
  return out;
}

export function domainReachVerdict(
  domain: Domain,
  channelKey: string,
): { readonly kind: "admits" | "excluded"; readonly entry: string } | undefined {
  const admits = mostSpecificMatch(parseEntries(domain.reach), channelKey);
  if (admits === undefined) return undefined;
  const excluded = mostSpecificMatch(parseEntries(domain.exclude), channelKey);
  return excluded === undefined ? { kind: "admits", entry: admits.entry } : { kind: "excluded", entry: excluded.entry };
}

export function resolveDomainForChannel(channelKey: string, domains: readonly Domain[]): DomainRouting {
  let winner: { readonly domain: Domain; readonly parsed: ReachEntry; readonly entry: string } | undefined;
  let vetoed: DomainVia | undefined;
  for (const d of domains) {
    const verdict = domainReachVerdict(d, channelKey);
    if (!verdict) continue;
    if (verdict.kind === "excluded") {
      vetoed ??= `excluded:${d.name}:${verdict.entry}`;
      continue;
    }
    const parsed = parseReachEntry(verdict.entry);
    if (!parsed) continue;
    if (winner === undefined || (entryContains(winner.parsed, parsed) && !surfaceKeyEntriesEquivalent(winner.parsed, parsed))) {
      winner = { domain: d, parsed, entry: verdict.entry };
    }
  }
  if (!winner) return { domain: undefined, via: vetoed ?? "none" };
  const exact = winner.parsed.kind === "surface" && !winner.parsed.glob;
  return { domain: winner.domain, via: exact ? "roster" : `container:${winner.entry}` };
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

export function externalPolicyOverrideFor(channelKey: string | undefined, domains: readonly Domain[]): ExternalPolicyOverride | undefined {
  const explicit = channelKey === undefined ? undefined : domainForChannel(channelKey, domains);
  if (explicit) return explicit.externalPolicy;
  return criteriaDomain("org", domains)?.externalPolicy;
}

export interface SilentRoomGrainValidationDeps {
  readonly warn?: (message: string) => void;
}

export function warnSilentRoomGrainWithoutPublicSignal(
  domains: readonly Domain[],
  orgDefaultRoomGrain: ExternalRoomGrain,
  declaredPublic: (workspaceKey: string, surfaceKey: string) => boolean,
  deps: SilentRoomGrainValidationDeps = {},
): void {
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  const checked = new Set<string>();
  for (const d of domains) {
    for (const ch of domainRoster(d)) {
      if (checked.has(ch)) continue;
      checked.add(ch);
      const override = externalPolicyOverrideFor(ch, domains);
      const roomGrain = override?.roomGrain ?? orgDefaultRoomGrain;
      if (roomGrain !== "silent") continue;
      const segs = ch.split("/");
      const workspaceKey = segs.slice(0, 2).join("/");
      if (declaredPublic(workspaceKey, ch)) continue;
      warn(
        `[open-everywhere:external-policy] channel "${ch}" (domain "${d.name}") resolves ` +
          `externalPolicy.roomGrain: "silent" but no "public" trust entry covers it in ` +
          `agent/identity/surfaces.ts — the OPERATOR-DECLARED leg of the external-room class can ` +
          `never arm here from static config. This is fine if a vendor-external (Slack Connect / ` +
          `Teams shared channel) or guest-present signal is meant to arm it at runtime instead; if ` +
          `the static declaration was meant to arm it, add a "public" surface entry for this channel.`,
      );
    }
  }
}

const AMBIENT_SUPERVISOR_DEFAULT = true;

function resolveAmbientSupervisor(
  channelKey: string,
  domains: readonly Domain[],
): { readonly on: boolean; readonly routing: DomainRouting; readonly declaredBy?: Domain; readonly unrouted?: true } {
  const routing = resolveDomainForChannel(channelKey, domains);
  const org = criteriaDomain("org", domains);
  if (routing.domain === undefined && org === undefined) return { on: false, routing, unrouted: true };
  for (const layer of [routing.domain, org]) {
    if (layer?.ambientSupervisor !== undefined) return { on: layer.ambientSupervisor, routing, declaredBy: layer };
  }
  return { on: AMBIENT_SUPERVISOR_DEFAULT, routing };
}

export function ambientSupervisorEnabled(channelKey: string, domains: readonly Domain[]): boolean {
  return resolveAmbientSupervisor(channelKey, domains).on;
}

export type AmbientSkip = "no-domain" | "domain-refused";

export function ambientSkipFor(
  channelKey: string,
  domains: readonly Domain[],
): { readonly reason: AmbientSkip; readonly domain?: string; readonly declaredBy?: string; readonly via: DomainVia } | undefined {
  const { on, routing, declaredBy, unrouted } = resolveAmbientSupervisor(channelKey, domains);
  if (on) return undefined;
  if (unrouted) return { reason: "no-domain", via: routing.via };
  const router = routing.domain ?? criteriaDomain("org", domains);
  return { reason: "domain-refused", domain: router?.name ?? declaredBy?.name, declaredBy: declaredBy?.name, via: routing.via };
}

export function admissionNameFor(channelKey: string, domains: readonly Domain[]): string {
  const explicit = domainForChannel(channelKey, domains);
  if (explicit) return explicit.admission ?? DEFAULT_ADMISSION;
  return criteriaDomain("org", domains)?.admission ?? DEFAULT_ADMISSION;
}

export function windowedSupervisorEnabled(channelKey: string, domains: readonly Domain[]): boolean {
  if (!windowTopologyEnabled()) return false;
  return standingSeatDomainFor(channelKey, domains) !== undefined;
}

export function standingSeatDomainFor(channelKey: string, domains: readonly Domain[]): Domain | undefined {
  return domainForChannel(channelKey, domains) ?? criteriaDomain("org", domains);
}

export function windowedDomainFor(channelKey: string, domains: readonly Domain[]): Domain | undefined {
  if (!windowedSupervisorEnabled(channelKey, domains)) return undefined;
  return standingSeatDomainFor(channelKey, domains);
}

export function windowModeFor(channelKey: string, domains: readonly Domain[]): WindowMode {
  const domain = domainForChannel(channelKey, domains);
  return domain ? resolvedWindowMode(domain, isVouchedInternal) : "solo";
}

export function defaultUnifiedFallback(d: Domain, vouched: readonly string[] | VouchedInternalFor): string | undefined {
  if (d.match !== undefined) return "pseudo-domain";
  if (domainContainers(d).length > 0) return "container-reach";
  const residue = domainRoster(d).filter((ch) => windowGroupFor(ch, d) === undefined);
  if (residue.length <= 1) return "single-member";
  const isInternal = vouchedPredicate(vouched);
  const trustEnv = getSettings().identity.blanketTrust === "internal";
  const unvouched = residue.find((ch) => !windowSourceVouched(ch, isInternal, trustEnv));
  return unvouched === undefined ? undefined : `unvouched:${unvouched}`;
}

export function resolvedWindowMode(d: Domain, vouched: readonly string[] | VouchedInternalFor): WindowMode {
  if (d.match !== undefined) return "solo";
  if (d.mode !== undefined) return d.mode;
  return defaultUnifiedFallback(d, vouched) === undefined ? "unified" : "solo";
}

export function windowGroupFor(channelKey: string, domain: Domain): WindowGroup | undefined {
  let winner: { readonly group: WindowGroup; readonly parsed: ReachEntry } | undefined;
  for (const group of domain.windows ?? []) {
    const admits = mostSpecificMatch(parseEntries(group.reach), channelKey);
    if (admits === undefined) continue;
    if (mostSpecificMatch(parseEntries(group.exclude), channelKey) !== undefined) continue;
    if (winner === undefined || (entryContains(winner.parsed, admits.parsed) && !surfaceKeyEntriesEquivalent(winner.parsed, admits.parsed))) {
      winner = { group, parsed: admits.parsed };
    }
  }
  return winner?.group;
}

export function windowIdFor(channelKey: string, domains: readonly Domain[]): string | undefined {
  const domain = domainForChannel(channelKey, domains);
  if (!domain) return undefined;
  return windowGroupFor(channelKey, domain)?.name;
}

function windowGroupShapeProblems(d: Domain): string[] {
  const groups = d.windows ?? [];
  const bad: string[] = [];
  if (d.match !== undefined) {
    bad.push(
      `  "${d.name}" (match "${d.match}") must not set windows — a standing window is a TEAM-section feature, never a pseudo-domain (org=the "window everything" footgun; public/dm=external/personal surface)`,
    );
  }
  if (groups.length === 0) {
    bad.push(`  "${d.name}" declares an EMPTY windows list — that grants nothing and reads as if it did; name at least one group, or drop the field`);
  }
  const seen = new Set<string>();
  for (const g of groups) {
    if (!WINDOW_GROUP_NAME_RE.test(g.name)) {
      bad.push(
        `  "${d.name}" names the window group "${g.name}", which is not a legal window id — a group name is lowercase kebab (${String(WINDOW_GROUP_NAME_RE)}) because it travels as the windowId through the session registry key ("oe-domain::<name>") and the supervisor token ("oe-dom:<domain>:win:<name>:oe-sup:g<gen>"), where "/" and ":" are structure`,
      );
      continue;
    }
    if (seen.has(g.name)) {
      bad.push(`  "${d.name}" declares the window group "${g.name}" TWICE — a group name is the window id, so the second declaration could never be elected`);
      continue;
    }
    seen.add(g.name);
    if ((g.reach?.length ?? 0) === 0) {
      bad.push(`  window group "${g.name}" of "${d.name}" names no members — give it a reach list, or drop it (an empty group elects nobody)`);
    }
    if ((g.exclude?.length ?? 0) > 0 && (g.reach?.length ?? 0) === 0) {
      bad.push(`  window group "${g.name}" of "${d.name}" sets exclude with no reach — an exclusion carves out of a REACH, so this pair is dead config; delete it`);
    }
    for (const entry of g.exclude ?? []) {
      const parsed = parseReachEntry(entry);
      if (!parsed || parsed.kind === "group") {
        bad.push(`  window group "${g.name}" of "${d.name}" excludes "${entry}", which is not a legal exclusion entry (a surface key, or a same-level \`prefix*\` glob)`);
        continue;
      }
      if (parsed.kind === "tenant") {
        bad.push(`  window group "${g.name}" of "${d.name}" excludes the whole tenant "${entry}" — a tenant-wide exclusion either cancels the group's reach outright or means nothing; name the surfaces`);
        continue;
      }
      const ownExact = domainRoster(g).find((ch) => entryMatchesKey(parsed, ch));
      if (ownExact !== undefined) {
        bad.push(
          `  window group "${g.name}" of "${d.name}" excludes "${entry}" but also reaches "${ownExact}" outright — an exclusion and the exact key it cancels are a contradiction, and the key would silently fall through to this domain's \`mode\` residue instead of the group: delete the reach entry, or the exclusion.`,
        );
      }
    }
    for (const entry of g.reach ?? []) {
      const parsed = parseReachEntry(entry);
      if (parsed?.kind === "group") {
        bad.push(
          `  window group "${g.name}" of "${d.name}" reaches "${entry}", which uses the GROUP rung (\`<marker>:<id>\`) — that shape belongs to the TRUST registry (agent/identity/surfaces.ts), never to a window group`,
        );
        continue;
      }
      if (!parsed) {
        bad.push(`  window group "${g.name}" of "${d.name}" reaches "${entry}", which is not a legal reach entry (see Domain.reach)`);
        continue;
      }
      if (parsed.kind === "surface" && !parsed.glob) continue;
      const withinDomainReach = domainContainers(d).some((own) => {
        const ownParsed = parseReachEntry(own);
        return ownParsed !== undefined && surfaceKeyEntriesIntersect(ownParsed, parsed);
      });
      if (!withinDomainReach) {
        bad.push(
          `  window group "${g.name}" of "${d.name}" reaches container "${entry}", which intersects none of that domain's own containers — a window narrows WITHIN its domain's reach and can never reach past it`,
        );
      }
    }
  }
  return bad;
}

export function assertUnifiedDomainTrust(domains: readonly Domain[]): void {
  const bad: string[] = [];
  for (const d of domains) {
    if (d.windows !== undefined) bad.push(...windowGroupShapeProblems(d));
    if (d.mode === undefined) continue;
    const isPseudo = d.match !== undefined;
    if (isPseudo) {
      bad.push(
        `  "${d.name}" (match "${d.match}") must not set mode — a standing window is a TEAM-section feature, never a pseudo-domain (org=the "window everything" footgun; public/dm=external/personal surface)`,
      );
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

export type VouchedInternalFor = (workspaceKey: string, surfaceKey: string) => boolean;

function vouchedPredicate(vouched: readonly string[] | VouchedInternalFor): VouchedInternalFor {
  if (typeof vouched === "function") return vouched;
  const vset = new Set(vouched);
  return (workspaceKey, surfaceKey) => vset.has(workspaceKey) || vset.has(surfaceKey);
}

function windowSourceVouched(ch: string, isInternal: VouchedInternalFor, trustEnv: boolean): boolean {
  const segs = ch.split("/");
  if (BINDING_TRUSTED_PLATFORMS.has(segs[0] ?? "")) return true;
  return isInternal(segs.slice(0, 2).join("/"), ch) || trustEnv;
}

function windowMemberSets(d: Domain, vouched: VouchedInternalFor): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, string[]>();
  const residueUnified = resolvedWindowMode(d, vouched) === "unified";
  for (const ch of domainRoster(d)) {
    const windowId = windowGroupFor(ch, d)?.name ?? (residueUnified ? d.name : ch);
    const members = out.get(windowId);
    if (members) members.push(ch);
    else out.set(windowId, [ch]);
  }
  return out;
}

export function assertWindowSourcesVouched(
  domains: readonly Domain[],
  vouched: readonly string[] | VouchedInternalFor,
  deps: { readonly warn?: (message: string) => void } = {},
): void {
  const isInternal = vouchedPredicate(vouched);
  const trustEnv = getSettings().identity.blanketTrust === "internal";
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  const bad: string[] = [];
  for (const d of domains) {
    if (d.match === undefined && d.mode === undefined) {
      const why = defaultUnifiedFallback(d, isInternal);
      if (why !== undefined && why !== "single-member") {
        warn(
          `[open-everywhere:window] domain "${d.name}" omits \`mode\`, so it would default to "unified", but it stays "solo" (${why}): ` +
            (why === "container-reach"
              ? `its reach holds a tenant or glob entry, and config load cannot prove that every room under it is internal. List the rooms as exact keys to share one window, or set mode: "solo" to silence this warning.`
              : `that room is not declared internal. Vouch it in agent/identity/surfaces.ts to share one window, or set mode: "solo" to silence this warning.`),
        );
      }
    }
    for (const [windowId, members] of windowMemberSets(d, isInternal)) {
      if (members.length <= 1) continue;
      const where = windowId === d.name ? `domain "${d.name}"` : `window "${windowId}" of domain "${d.name}"`;
      for (const ch of members) {
        const segs = ch.split("/");
        const platform = segs[0] ?? "";
        const workspaceKey = segs.slice(0, 2).join("/");
        if (!windowSourceVouched(ch, isInternal, trustEnv)) {
          bad.push(
              `  ${where} includes UN-vouched source "${ch}" in a multi-source (${members.length}-channel) cross-surface window — vouch it in agent/identity/surfaces.ts (add "${ch}" or its workspace "${workspaceKey}"), or declare \`identity.blanketTrust: "internal"\` in agent/settings/settings.ts for an internal-only deploy` +
              (platform === "notion"
                ? `. A Notion TRUST ROOT does not satisfy this gate: the ancestor walk runs per delivery against the live Notion API, so config load cannot resolve it. Declare this page in the register as well`
                :
                  platform === "teams"
                  ? `. For TEAMS, this tenant entry is enough for a cross-surface SINGLE WINDOW member too: the window privacy floor walks the declaration rungs (OPE-1521), so a "teams/<tenantId>" declaration admits every room under the tenant. 🔴 Weigh that REACH — it covers rooms you never named, a cross-tenant Connect/shared channel among them, because an inbound Teams activity usually omits membershipType. Declare a "teams/<tenantId>/<threadId>" key to narrow it to one channel. See docs/deploy/surfaces/teams.md`
                  : ``),
          );
        }
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
  const first = governanceDomains(domains).flatMap((d) => domainRoster(d))[0];
  return first ?? fallback;
}

export function governanceDeliveryMode(domains: readonly Domain[]): GovernanceDeliveryMode {
  return criteriaDomain("org", domains)?.governanceDelivery === "dm-fallback" ? "dm-fallback" : "channel";
}

export function assertGovernanceDomains(domains: readonly Domain[], vouched: readonly string[] | VouchedInternalFor): void {
  const isInternal = vouchedPredicate(vouched);
  const trustEnv = getSettings().identity.blanketTrust === "internal";
  const bad: string[] = [];
  for (const d of domains) {
    if (d.governanceDelivery !== undefined && d.match !== "org") {
      bad.push(
        `  "${d.name}" sets governanceDelivery, but that is a single ORG-WIDE knob — move it to the "org" pseudo-domain (the { match: "org" } domain); there is deliberately no per-domain delivery policy`,
      );
    }
    if (d.governance !== true) continue;
    const channels = domainRoster(d);
    if (d.match !== undefined || d.reach === undefined) {
      bad.push(`  "${d.name}" is governance but has no reach — a governance venue must list concrete channels, never a match/pseudo-domain`);
    }
    if (!d.admins || d.admins.length === 0) {
      bad.push(`  "${d.name}" is governance but has an empty admins roster — a governance venue with no admins unlocks nothing (add the org's admin principal ids to its admins list)`);
    }
    const governanceContainers = domainContainers(d);
    if (governanceContainers.length > 0) {
      bad.push(`  "${d.name}" is governance but reaches container(s) [${governanceContainers.join(", ")}] — a governance venue is a SMALL, enumerated, individually-vouched audience, and neither the ${GOVERNANCE_CHANNEL_MAX}-channel cap nor the per-channel vouch can be decided over an unbounded container, whether it is a whole tenant or a \`prefix*\` glob (list the concrete channels, or drop governance from this domain)`);
    }
    if (d.exclude !== undefined) {
      bad.push(`  "${d.name}" is governance but sets exclude [${d.exclude.join(", ")}] — an exclusion carves surfaces out of a CONTAINER, and a governance venue may not reach one at all; its audience is the exact keys of its \`reach\` and nothing else (drop exclude)`);
    }
    if (channels.length > GOVERNANCE_CHANNEL_MAX) {
      bad.push(`  "${d.name}" is governance with ${channels.length} channels — that exceeds the ${GOVERNANCE_CHANNEL_MAX}-channel governance cap (a governance domain is a SMALL uniformly-privileged venue; split it or re-tag)`);
    }
    for (const ch of channels) {
      const segs = ch.split("/");
      const platform = segs[0] ?? "";
      if (BINDING_TRUSTED_PLATFORMS.has(platform)) continue;
      const workspaceKey = segs.slice(0, 2).join("/");
      if (!(isInternal(workspaceKey, ch) || trustEnv)) {
        bad.push(`  "${d.name}" is governance but its channel "${ch}" is not operator-vouched-internal — vouch it in agent/identity/surfaces.ts (add "${ch}" or its workspace "${workspaceKey}"), or declare \`identity.blanketTrust: "internal"\` in agent/settings/settings.ts for an internal-only deploy`);
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
    if (d.reach === undefined || d.match !== undefined) {
      bad.push(`  "${d.name}" sets reportChannel but has no reach — a report redirect must name a concrete room inside a concrete domain, never a match/pseudo-domain`);
      continue;
    }
    const roster = domainRoster(d);
    if (!roster.includes(rc)) {
      bad.push(`  "${d.name}" sets reportChannel "${rc}", which is not one of its own exact reach entries — a routine may only be redirected INSIDE its domain, to a room config names outright (add "${rc}" to "${d.name}".reach, or point reportChannel at one of: ${roster.join(", ")})`);
    }
  }
  if (bad.length > 0) {
    throw new Error("open-everywhere: invalid domain reportChannel(s):\n" + bad.join("\n") + "\n(memory/domain.ts assertReportChannels — OPE-148).");
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

const entriesIntersect = surfaceKeyEntriesIntersect;

function exclusionCovering(domain: Domain, set: ReachEntry): string | undefined {
  for (const entry of domain.exclude ?? []) {
    const parsed = parseReachEntry(entry);
    if (parsed && entryContains(parsed, set)) return entry;
  }
  return undefined;
}

export function assertChannelExclusivity(domains: readonly Domain[]): void {
  const clashes: string[] = [];
  const reach = domains.map((d) => ({ domain: d, entries: parseEntries(d.reach) }));
  for (let i = 0; i < reach.length; i++) {
    for (let j = i + 1; j < reach.length; j++) {
      const a = reach[i]!;
      const b = reach[j]!;
      if (a.domain.name === b.domain.name) continue;
      for (const ae of a.entries) {
        for (const be of b.entries) {
          if (!surfaceKeyEntriesEquivalent(ae.parsed, be.parsed)) continue;
          if (exclusionCovering(a.domain, be.parsed) !== undefined) continue;
          if (exclusionCovering(b.domain, ae.parsed) !== undefined) continue;
          clashes.push(
            ae.parsed.kind === "surface" && !ae.parsed.glob
              ? `  "${ae.entry}" is in the reach of both "${a.domain.name}" and "${b.domain.name}"`
              : ae.parsed.kind === "tenant"
                ? `  the tenant "${ae.entry}" is reached by both "${a.domain.name}" and "${b.domain.name}", so which domain owns a key under it would depend on declaration order — narrow one of them to a \`<prefix>*\` glob or to exact keys`
                : `  the reach entries "${ae.entry}" ("${a.domain.name}") and "${be.entry}" ("${b.domain.name}") match exactly the SAME keys, so which domain owns them would depend on declaration order — narrow one of them, or add exclude: ["${be.entry}"] to the domain that should NOT get them`,
          );
        }
      }
    }
  }
  for (const d of domains) {
    for (const key of domainRoster(d)) {
      const owner = resolveDomainForChannel(key, domains);
      if (owner.domain?.name === d.name) continue;
      clashes.push(
        `  "${key}" is named by "${d.name}" but routes to ${owner.domain ? `"${owner.domain.name}"` : `NO domain (via: ${owner.via})`} — a room config names outright must land in the domain that named it, or it gets no memory, no bundle and no ambient supervisor, and says so only by staying silent`,
      );
    }
  }
  if (clashes.length > 0) {
    throw new Error(
      "open-everywhere: a channel belongs to at most one memory domain, and a room a domain names outright belongs to that one, but:\n" +
        clashes.join("\n") +
        "\nRemove the channel from all but one domain (docs/capabilities/memory.md).",
    );
  }
}

export function assertWindowGroupExclusivity(domains: readonly Domain[]): void {
  const clashes: string[] = [];
  const domainNames = new Map<string, string>();
  for (const d of domains) domainNames.set(d.name, d.name);
  const groupOwner = new Map<string, string>();
  for (const d of domains) {
    for (const g of d.windows ?? []) {
      if (domainNames.has(g.name)) {
        clashes.push(
          `  window group "${g.name}" of "${d.name}" has the same name as the domain "${g.name}" — a domain name is itself a window id (the id-equals-domain form), so the two would share the session registry row "oe-domain::${g.name}"`,
        );
      }
      for (const ch of domainRoster(g)) {
        const owner = domainForChannel(ch, domains);
        if (owner?.name !== d.name) {
          clashes.push(
            `  window group "${g.name}" of "${d.name}" lists "${ch}", which config routes to ${owner ? `domain "${owner.name}"` : "no domain"} — a window slices a domain it cannot widen, so add the key to "${d.name}".reach first (or list it in a group of the domain that does own it)`,
          );
        }
      }
      const prev = groupOwner.get(g.name);
      if (prev !== undefined && prev !== d.name) {
        clashes.push(
          `  the window group name "${g.name}" is declared by both "${prev}" and "${d.name}" — a window id keys the session registry GLOBALLY ("oe-domain::${g.name}"), so the two domains would share one standing context window`,
        );
      } else {
        groupOwner.set(g.name, d.name);
      }
    }
    const groups = d.windows ?? [];
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const a = groups[i]!;
        const b = groups[j]!;
        if (a.name === b.name) continue;
        for (const ae of parseEntries(a.reach)) {
          for (const be of parseEntries(b.reach)) {
            if (!surfaceKeyEntriesEquivalent(ae.parsed, be.parsed)) continue;
            const covers = (g: WindowGroup, set: ReachEntry): boolean =>
              parseEntries(g.exclude).some((x) => surfaceKeyEntryContains(x.parsed, set));
            if (covers(a, be.parsed) || covers(b, ae.parsed)) continue;
            clashes.push(
              ae.parsed.kind === "surface" && !ae.parsed.glob
                ? `  "${ae.entry}" is in the reach of both window groups "${a.name}" and "${b.name}" of "${d.name}"`
                : `  the reach entries "${ae.entry}" (window group "${a.name}") and "${be.entry}" (window group "${b.name}") of "${d.name}" match exactly the SAME keys, so which WINDOW owns them would depend on declaration order — narrow one of them, or add exclude: ["${be.entry}"] to the group that should NOT get them`,
            );
          }
        }
      }
    }
  }
  if (clashes.length > 0) {
    throw new Error(
      "open-everywhere: invalid standing-window group configuration:\n" +
        clashes.join("\n") +
        "\n(memory/domain.ts assertWindowGroupExclusivity — a window id keys one standing session).",
    );
  }
}

export function assertDomainsValid(domains: readonly Domain[]): void {
  const bad: string[] = [];
  const byMatch = new Map<DomainMatch, string>();
  let hasOrg = false;
  for (const d of domains) {
    if ((d as { readonly requestorEntitlementChecks?: unknown }).requestorEntitlementChecks !== undefined) {
      bad.push(
        `  "${d.name}" sets requestorEntitlementChecks, which is REMOVED. Core never shipped an entitlement probe: with the key set to true and no probe registered, the flag refused every directly-addressed connector call. A turn runs as its ROOM, never as a person. Delete the key. Connector reads are now judged on the room's audience floor only (see UPGRADING.md).`,
      );
    }
    if (d.name.startsWith(DM_ANCHOR_DOMAIN_PREFIX)) {
      bad.push(
        `  "${d.name}" starts with the RESERVED prefix "${DM_ANCHOR_DOMAIN_PREFIX}" — that namespace belongs to the DM delegation anchor (channels/window-key.ts dmAnchorDomain, OPE-306) and can never be a configured domain name. Rename it.`,
      );
    }
    if (d.language !== undefined) {
      const problem = languageTagProblem(d.language);
      if (problem !== undefined) bad.push(`  "${d.name}" sets language ${JSON.stringify(d.language)}, which ${problem}`);
    }
    bad.push(...domainCredentialProblems(d));
    bad.push(...credentialGrantDeclarationProblems(d));
    if (d.admission !== undefined && !isAdmissionFunctionName(d.admission)) {
      bad.push(
        `  "${d.name}" sets admission "${d.admission}", which is not a registered admission function — use one of: ${admissionFunctionNames().join(", ")} (channels/seat-admission.ts SEAT_ADMISSION_FUNCTIONS; a new policy is deterministic code added there by PR, never a config string)`,
      );
    }
    const hasExplicit = d.reach !== undefined;
    const hasMatch = d.match !== undefined;
    if (hasExplicit === hasMatch) {
      bad.push(`  "${d.name}" must have EITHER a reach list OR match (criteria), not ${hasExplicit ? "both" : "neither"}`);
    }
    const reachEntries: ParsedEntry[] = [];
    for (const key of [...(d.reach ?? []), ...(d.exclude ?? [])]) {
      const seg3 = key.split("/")[2];
      if (seg3 !== undefined && isGroupSegment(seg3)) {
        bad.push(
          `  "${d.name}" names "${key}", which uses the GROUP rung (\`<marker>:<id>\`) — that shape belongs to the TRUST registry (agent/identity/surfaces.ts), never to a memory domain. A memory key is \`platform/<tenant>\` or \`platform/<tenant>/<surface>\`, and no surface segment can contain a colon, so this entry could never match anything.`,
        );
      }
    }
    for (const key of d.reach ?? []) {
      const parsed = parseReachEntry(key);
      if (parsed?.kind === "group") continue;
      if (parsed) {
        reachEntries.push({ entry: key, parsed });
        continue;
      }
      const segs = key.split("/");
      bad.push(
        segs.length > 3
          ? `  "${d.name}" reaches "${key}", but INTERMEDIATE containers are not supported — a reach entry is an exact surface key \`platform/<tenant>/<surface>\`, a two-segment tenant key \`platform/<tenant>\` (e.g. "github/acme", "linear/<orgId>", "notion/<workspaceId>"), or a three-segment same-level glob \`platform/<tenant>/<prefix>*\` (e.g. "github/acme/payments-*") — never a deeper path. A deeper container ("every row under this database") needs an ancestor walk the webhook payload cannot prove and an API call per level, so it is refused BY NAME rather than admitted with no reader. List the concrete surfaces instead.`
          : `  "${d.name}" reaches "${key}", which is none of the three legal shapes: an exact surface key \`platform/<tenant>/<surface>\`, a tenant key \`platform/<tenant>\`, or a same-level glob \`platform/<tenant>/<prefix>*\`. The glob is deliberately ONE trailing \`*\` on the LAST segment — never \`**\`, never mid-string, never in the platform or tenant segment, never a regex — because overlap between two entries has to be decidable at config load (assertChannelExclusivity), and an undecidable overlap is an at-most-one-domain hole.`,
      );
    }
    for (const key of d.exclude ?? []) {
      const parsed = parseReachEntry(key);
      if (parsed?.kind === "group") continue;
      if (!parsed || parsed.kind === "tenant") {
        bad.push(
          parsed
            ? `  "${d.name}" excludes "${key}", which is a WHOLE TENANT — an exclusion carves surfaces out of a domain's reach, so it is a three-segment surface key ("github/acme/payments-secrets") or a same-level glob ("github/acme/payments-secret-*"). A tenant-wide exclusion either cancels the reach outright or means nothing; drop the reach entry instead.`
            : `  "${d.name}" excludes "${key}", which is not a surface key \`platform/<tenant>/<surface>\` nor a same-level glob \`platform/<tenant>/<prefix>*\` (one trailing \`*\` on the last segment only — see the reach rule)`,
        );
        continue;
      }
      const ownExact = domainRoster(d).find((ch) => entryMatchesKey(parsed, ch));
      if (ownExact !== undefined) {
        bad.push(
          `  "${d.name}" excludes "${key}" but also reaches "${ownExact}" outright — an exclusion and the exact key it cancels are a contradiction: delete the reach entry, or the exclusion.`,
        );
        continue;
      }
      const cancels = reachEntries.find((c) => entryContains(parsed, c.parsed));
      if (cancels) {
        bad.push(
          `  "${d.name}" excludes "${key}", which cancels the WHOLE of its reach entry "${cancels.entry}" — that pair is dead config (the reach can never admit anything). Delete both, or narrow the exclusion.`,
        );
        continue;
      }
      if (!reachEntries.some((c) => entriesIntersect(parsed, c.parsed))) {
        bad.push(
          `  "${d.name}" excludes "${key}", but none of its \`reach\` entries [${(d.reach ?? []).join(", ") || "<none>"}] can match it — a dead exclusion reads like a carve-out and grants everything it was meant to withhold. Fix the key, or drop it.`,
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
  bad.push(...partitionTenantProblems(domains));
  if (bad.length > 0) {
    throw new Error(
      "open-everywhere: invalid memory domain(s):\n" + bad.join("\n") + "\n(memory/domain.ts / docs/capabilities/memory.md)",
    );
  }
}

const CONFIG_DERIVED_TENANT_PLATFORMS: ReadonlySet<string> = new Set(["notion"]);

export function partitionTenantProblems(domains: readonly Domain[]): string[] {
  const bad: string[] = [];
  for (const d of domains) {
    const byPlatform = new Map<string, Set<string>>();
    for (const entry of domainContainers(d)) {
      const parsed = parseReachEntry(entry);
      if (!parsed || !CONFIG_DERIVED_TENANT_PLATFORMS.has(parsed.platform)) continue;
      const tenants = byPlatform.get(parsed.platform) ?? new Set<string>();
      tenants.add(parsed.tenant);
      byPlatform.set(parsed.platform, tenants);
    }
    for (const [platform, tenants] of [...byPlatform].sort(([a], [b]) => a.localeCompare(b))) {
      if (tenants.size < 2) continue;
      bad.push(
        `  "${d.name}" reaches ${tenants.size} ${platform} tenants by container (${[...tenants].sort().map((t) => JSON.stringify(t)).join(", ")}) — on ${platform} the session partition's tenant segment comes from the matched \`reach\` entry, because the delivery's own tenant field is unauthenticated and no API call can confirm it. A container states no tenant for the surfaces it sweeps in, so with two of them one surface's history can key under either depending on what a payload says. Split this into one domain per ${platform} tenant, or name the surfaces outright (an exact entry carries its own tenant and is never ambiguous).`,
      );
    }
  }
  return bad;
}
