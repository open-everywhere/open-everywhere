import { isScheduleAuth } from "eve/schedules";
import type { SessionMode } from "../access/resolver.js";
import { readBindingBridge, stampBindingBridge, bridgedContext, type BridgedIdentity } from "./binding-bridge.js";
import { normalizePlatform, platformFromKind } from "./platform.js";
import { seg, deploymentOrg, ambientWorkspace, ambientSurface } from "./deployment-identity.js";
import { admitProviderRegistration } from "../access/provider-selection.js";
import { declaredSurfaceTrust, type SurfaceTrust } from "./trust.js";

import { UNNAMED_TENANT } from "./principal-key.js";
import { classifySessionId, parseWindowToken } from "../channels/window-key.js";
import { conversationGrantKey, roomCallGrantKey, type GrantReach } from "../approvals/session-grant.js";
import { sourcesForWindow, decodeSources } from "../channels/window-sources.js";
import { ROUTINE_MARKER, routinePermissionKeyStamped } from "../routines/routine.js";
import type { Domain } from "../memory/domain.js";
import { processRegistryMap, processRegistrySlot } from "../lib/process-registry.js";
import { getSettings } from "../settings/settings.js";
import { taskWakeThisTurn, uningressedTurn } from "../access/task-wake-signal.js";
import { delegatedBindingAdopted, delegatedBindingThisTurn, delegatedRootSessionId, delegatedSlotState } from "./delegated-binding.js";
import { frozenSurfaceBindingFrom } from "./frozen-surface-binding.internal.js";

export type Visibility = "public" | "private";

export type Trust = "internal" | "external";

export interface SurfaceBinding {
  readonly org: string;
  readonly platform: string;
  readonly workspace: string;
  readonly surface: string;
  readonly domainSurface?: string;
  readonly mode: SessionMode;
  readonly modeResolved?: true;
  readonly visibility: Visibility;
  readonly trust: Trust;
  readonly enterprise?: string;
  readonly declaredTrust?: SurfaceTrust;
  readonly principalId?: string;
  readonly principalAttested?: true;
  readonly target?: Readonly<Record<string, unknown>>;
  readonly threadTs?: string;
  readonly engagementKey?: string;
  readonly roomEngagementKey?: string;
  readonly anchorMessageId?: string;
  readonly anchorChannelId?: string;
}

interface AuthPrincipal {
  readonly attributes?: Readonly<Record<string, string | readonly string[]>>;
  readonly principalId?: string;
  readonly principalType?: string;
  readonly authenticator?: string;
}
export interface BindableContext {
  readonly session?: {
    readonly auth?: {
      readonly current?: AuthPrincipal | null;
      readonly initiator?: AuthPrincipal | null;
    } | null;
    readonly parent?: { readonly sessionId?: string; readonly callId?: string; readonly rootSessionId?: string };
    readonly id?: string;
  };
  readonly channel?: { readonly kind?: string; readonly continuationToken?: string };
}

function trustGroupKey(
  platform: string,
  workspace: string,
  group: string | undefined,
): { readonly groupKey: string } | undefined {
  const key = trustGroupKeyFor(`${platform}/${workspace}`, group);
  return key === undefined ? undefined : { groupKey: key };
}

export function trustGroupKeyFor(workspaceKey: string, group: string | undefined): string | undefined {
  if (group === undefined || !/^[a-zA-Z0-9._-]+:[a-zA-Z0-9._-]+$/.test(group)) return undefined;
  return `${workspaceKey}/${group}`;
}

function trustEnterpriseKey(
  platform: string,
  enterprise: string | undefined,
): { readonly enterpriseKey: string } | undefined {
  const spelled = seg(enterprise, "");
  if (spelled.length === 0) return undefined;
  return { enterpriseKey: `${platform}/${spelled}` };
}

export function surfaceKeySegment(value: string | undefined): string {
  return seg(value, "");
}

export { deploymentOrg } from "./deployment-identity.js";

function authOf(ctx: BindableContext): AuthPrincipal | null {
  return ctx.session?.auth?.current ?? ctx.session?.auth?.initiator ?? null;
}

export function authPrincipalId(ctx: BindableContext): string | undefined {
  const pid = authOf(ctx)?.principalId;
  return pid && pid.length > 0 ? pid : undefined;
}

function attr(a: AuthPrincipal["attributes"], keys: readonly string[]): string | undefined {
  if (!a) return undefined;
  for (const k of keys) {
    const v = a[k];
    if (typeof v === "string" && v.length > 0) return v;
    if (Array.isArray(v) && typeof v[0] === "string" && v[0].length > 0) return v[0];
  }
  return undefined;
}

export const FIRE_PRINCIPAL_ATTR = "oe_fire_principal";
export const FIRE_PRINCIPAL_TRUST_ATTR = "oe_fire_principal_trust";
export const FIRE_UNATTENDED_ATTR = "oe_fire_unattended";

function attestedFirePrincipal(ctx: BindableContext): { readonly id: string; readonly internal: boolean } | undefined {
  const a = authOf(ctx)?.attributes;
  const id = attr(a, [FIRE_PRINCIPAL_ATTR, "oeFirePrincipal"]);
  if (id === undefined) return undefined;
  return { id, internal: attr(a, [FIRE_PRINCIPAL_TRUST_ATTR, "oeFirePrincipalTrust"]) === "internal" };
}

export const WORK_FIRE_CREATOR_ATTR = "oe_work_fire_creator";

export function workResultFrozenBinding(ctx: BindableContext): SurfaceBinding | undefined {
  try {
    if (attr(authOf(ctx)?.attributes, ["oe_work_result"]) === undefined) return undefined;
    const frozen = frozenSurfaceBindingFrom(ctx);
    return frozen !== undefined && frozen.org === deploymentOrg() ? frozen : undefined;
  } catch {
    return undefined;
  }
}

export function fireResultCreatorId(ctx: BindableContext): string | undefined {
  return attr(authOf(ctx)?.attributes, [WORK_FIRE_CREATOR_ATTR]);
}

export function attestedFireCreatorId(ctx: BindableContext): string | undefined {
  return attestedFirePrincipal(ctx)?.id;
}

function unattendedOrigin(ctx: BindableContext): boolean {
  return attr(authOf(ctx)?.attributes, [FIRE_UNATTENDED_ATTR, "oeFireUnattended"]) === "true";
}

export const SCHEDULE_APP_AUTHENTICATOR = "app";
export const SCHEDULE_APP_PRINCIPAL_ID = "eve:app";
export const SCHEDULE_APP_PRINCIPAL_TYPE = "runtime";

interface ScheduleAuthSlot {
  readonly authenticator?: unknown;
  readonly principalId?: unknown;
  readonly principalType?: unknown;
}

export function isScheduleOriginatedAuth(auth: ScheduleAuthSlot | null | undefined): boolean {
  return isScheduleAuth(auth as Parameters<typeof isScheduleAuth>[0]);
}

function routineMarkerDelivery(ctx: BindableContext): boolean {
  return attr(authOf(ctx)?.attributes, [ROUTINE_MARKER.id]) !== undefined;
}

function unattendedDelivery(ctx: BindableContext): boolean {
  return unattendedOrigin(ctx) || routineMarkerDelivery(ctx) || isScheduleOriginatedAuth(authOf(ctx));
}

export function actingPrincipalId(binding: SurfaceBinding): string | undefined {
  return binding.principalAttested ? undefined : binding.principalId;
}

export function unattendedFrom(binding: SurfaceBinding): boolean {
  return actingPrincipalId(binding) === undefined;
}

export interface RawIdentity {
  readonly workspace?: string;
  readonly surface?: string;
  readonly domainSurface?: string;
  readonly mode?: SessionMode;
  readonly visibility?: Visibility;
  readonly trust?: Trust;
  readonly trustVerified?: boolean;
  readonly trustGroup?: string;
  readonly trustEnterprise?: string;
  readonly principalId?: string;
  readonly target?: Readonly<Record<string, unknown>>;
  readonly threadTs?: string;
  readonly engagementKey?: string;
  readonly roomEngagementKey?: string;
  readonly anchorMessageId?: string;
  readonly anchorChannelId?: string;
}

export type IdentityMapper = (ctx: BindableContext) => RawIdentity;
type Mapper = IdentityMapper;

const ENV_MODES: ReadonlySet<string> = new Set(["channel", "dm", "mpim"]);

const bindLocal: Mapper = (ctx) => {
  const envMode = process.env.OE_MODE;
  const envVis = process.env.OE_VISIBILITY;
  const blanketTrust = getSettings().identity.blanketTrust;
  return {
    workspace: undefined,
    surface: undefined,
    mode: envMode && ENV_MODES.has(envMode) ? (envMode as SessionMode) : undefined,
    visibility: envVis === "private" ? "private" : "public",
    trust: blanketTrust === "none" ? undefined : blanketTrust,
    principalId: authPrincipalId(ctx) ?? process.env.OE_PRINCIPAL,
    target: undefined,
  };
};

const MAPPERS = processRegistryMap<Mapper>("identity-mappers.v1");

export function registerIdentityMapper(platform: string, mapper: IdentityMapper): void {
  if (!admitProviderRegistration(platform, "identity-mapper")) return;
  MAPPERS.set(platform, mapper);
}

export function registeredIdentityMapperPlatforms(): readonly string[] {
  return [...MAPPERS.keys()].sort();
}

export const OE_WORK_SEAT_SESSION_ATTR = "oe_work_seat_session";

export const OE_WORK_SEAT_WAKE_ATTR = "oe_work_seat_wake";

export function workSeatWakeOf(ctx: BindableContext): string | undefined {
  try {
    return isSubagentChildContext(ctx) ? attr(authOf(ctx)?.attributes, [OE_WORK_SEAT_WAKE_ATTR]) : undefined;
  } catch {
    return undefined;
  }
}

export const SUBAGENT_CHANNEL_KIND = "subagent";

export function subagentParentSessionId(ctx: BindableContext): string | undefined {
  const id = ctx.session?.parent?.sessionId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

export function delegationRootSessionId(ctx: BindableContext): string | undefined {
  try {
    if (isSubagentChildContext(ctx)) {
      const seat = attr(authOf(ctx)?.attributes, [OE_WORK_SEAT_SESSION_ATTR]);
      if (seat !== undefined) return seat;
    }
    const parent = ctx.session?.parent;
    const root = parent?.rootSessionId;
    if (typeof root === "string" && root.length > 0) return root;
    const direct = subagentParentSessionId(ctx);
    if (direct !== undefined) return direct;
    return isSubagentChildContext(ctx) ? delegatedRootSessionId() : undefined;
  } catch {
    return undefined;
  }
}

export function isSubagentChildContext(ctx: BindableContext): boolean {
  try {
    if (subagentParentSessionId(ctx) !== undefined) return true;
    if (platformFromKind(ctx.channel?.kind) === SUBAGENT_CHANNEL_KIND) return true;
    return classifySessionId(ctx.channel?.continuationToken).kind === "subagent";
  } catch {
    return false;
  }
}

const PLATFORM_STAND_IN = processRegistrySlot<string>("binding.platform-stand-in.v1");

export function setPlatformStandInForTest(platform: string | null): void {
  PLATFORM_STAND_IN.set(platform);
}

export function channelPlatform(ctx: BindableContext): string | undefined {
  if (platformFromKind(ctx.channel?.kind) === SUBAGENT_CHANNEL_KIND) {
    const delegated = delegatedBindingThisTurn(currentTurnId(ctx));
    if (delegated !== undefined) return normalizePlatform(delegated.platform);
    const inherited = attr(authOf(ctx)?.attributes, ["oe_platform", "oePlatform"]);
    return inherited ? normalizePlatform(inherited) : SUBAGENT_CHANNEL_KIND;
  }
  const kind = platformFromKind(ctx.channel?.kind ?? PLATFORM_STAND_IN.get() ?? undefined);
  if (kind === "unified") {
    const stamped = attr(authOf(ctx)?.attributes, ["oe_platform", "oePlatform"]);
    return stamped ? normalizePlatform(stamped) : kind;
  }
  return kind;
}

export function isUnifiedWindowContext(ctx: BindableContext): boolean {
  return platformFromKind(ctx.channel?.kind) === "unified";
}

export function turnOriginPlatform(ctx: BindableContext): string | undefined {
  const live = channelPlatform(ctx);
  if (live !== undefined) return live;
  const stamped = attr(authOf(ctx)?.attributes, ["oe_platform", "oePlatform"]);
  if (stamped) return normalizePlatform(stamped);
  const bound = bindFrom(ctx).platform;
  return bound === "local" ? undefined : bound;
}

export function currentWakeId(ctx: BindableContext): string | undefined {
  if (isSubagentChildContext(ctx)) return undefined;
  const turnId = currentTurnId(ctx);
  const adopted = taskWakeThisTurn(turnId);
  if (adopted !== undefined) return adopted;
  if (uningressedTurn(turnId)) return undefined;
  return inheritedWakeStampOf(ctx);
}

export function inheritedWakeStampOf(ctx: BindableContext): string | undefined {
  return attr(authOf(ctx)?.attributes, ["oe_wake_id", "oeWakeId"]);
}

export function deliveryStampOf(ctx: BindableContext): string | undefined {
  return attr(authOf(ctx)?.attributes, ["oe_delivery_id", "oeDeliveryId"]) ?? inheritedWakeStampOf(ctx);
}

export function currentTurnId(ctx: BindableContext): string | undefined {
  const turn = (ctx as { session?: { turn?: { id?: string } } }).session?.turn;
  return typeof turn?.id === "string" && turn.id.length > 0 ? turn.id : undefined;
}

export function currentSessionId(ctx: BindableContext): string | undefined {
  const session = (ctx as { session?: { id?: unknown; sessionId?: unknown } }).session;
  const id = session?.id;
  if (typeof id === "string" && id.length > 0) return id;
  const legacy = session?.sessionId;
  return typeof legacy === "string" && legacy.length > 0 ? legacy : undefined;
}

export function currentWindowToken(ctx: BindableContext): string | undefined {
  return attr(authOf(ctx)?.attributes, ["oe_window_token", "oeWindowToken"]);
}

export function proposingGrantScope(ctx: BindableContext): { readonly key: string; readonly reach: GrantReach } | undefined {
  const routineKey = routinePermissionKeyStamped(authOf(ctx)?.attributes);
  if (routineKey !== undefined) return { key: routineKey, reach: "routine" };
  const binding = bindFrom(ctx);
  if (unattendedFrom(binding)) return undefined;
  if (binding.platform === "subagent") return undefined;
  return { key: conversationGrantKey(binding) ?? roomCallGrantKey(binding), reach: "call" };
}

export function proposingGrantKey(ctx: BindableContext): string | undefined {
  const scope = proposingGrantScope(ctx);
  return scope?.reach === "routine" ? scope.key : undefined;
}

export function currentTurnAddressing(ctx: BindableContext): string | undefined {
  if (isSubagentChildContext(ctx)) return undefined;
  return attr(authOf(ctx)?.attributes, ["oe_addressing", "oeAddressing"]);
}

export function currentTurnAddressed(ctx: BindableContext): boolean {
  if (isSubagentChildContext(ctx)) return false;
  const a = authOf(ctx)?.attributes;
  const flag = attr(a, ["oe_addressed", "oeAddressed"]);
  if (flag !== undefined) return flag === "1" || flag.toLowerCase() === "true";
  const addressing = attr(a, ["oe_addressing", "oeAddressing"]);
  return addressing === "direct-mention" || addressing === "direct";
}

export function currentTurnBotName(ctx: BindableContext): string | undefined {
  return attr(authOf(ctx)?.attributes, ["oe_bot_name", "oeBotName"]);
}

export function currentTurnIssue(ctx: BindableContext): string | undefined {
  return attr(authOf(ctx)?.attributes, ["issue_id", "issueId", "issue_identifier", "issueIdentifier"]);
}

export function currentTurnPage(ctx: BindableContext): string | undefined {
  return attr(authOf(ctx)?.attributes, ["page_id", "pageId"]);
}

export function currentTurnOrganization(ctx: BindableContext): string | undefined {
  return attr(authOf(ctx)?.attributes, ["organization_id", "organizationId"]);
}

export function currentTurnGithubTarget(ctx: BindableContext): { owner: string; repo: string; number: number; isPr: boolean } | undefined {
  if (channelPlatform(ctx) !== "github") return undefined;
  const a = authOf(ctx)?.attributes;
  const owner = attr(a, ["owner"]);
  const repo = attr(a, ["repo"]);
  if (!owner || !repo) return undefined;
  const conversationKind = attr(a, ["conversation_kind", "conversationKind"]);
  const issueNumber = attr(a, ["issue_number", "issueNumber"]);
  const pullRequestNumber = attr(a, ["pull_request_number", "pullRequestNumber"]);
  const isPrKind = conversationKind === "pull_request" || conversationKind === "review_thread";
  if (isPrKind && pullRequestNumber) return { owner, repo, number: Number(pullRequestNumber), isPr: true };
  if (issueNumber) return { owner, repo, number: Number(issueNumber), isPr: false };
  if (pullRequestNumber) return { owner, repo, number: Number(pullRequestNumber), isPr: true };
  return undefined;
}

export class TurnOriginFenceError extends Error {
  constructor(message: string, readonly surface: string) {
    super(message);
  }
}

export function assertTurnSurface(ctx: BindableContext, surface: string): void {
  const origin = turnOriginPlatform(ctx);
  if (origin === surface) return;
  throw new TurnOriginFenceError(
    origin === undefined
      ? `this tool reads ${surface}, but this turn's origin surface could not be resolved — a per-surface read only runs on a turn this deployment can place on ${surface}.`
      : `this tool reads ${surface}, but the message that woke this turn came from ${origin} — ` +
        `on a cross-surface session a per-surface read tool only runs on a turn from its OWN surface (what you can recall across surfaces is the shared context, not another surface's live reads).`,
    surface,
  );
}

export type WindowGrain = "standing" | "task" | "native" | "thread";

function classifyTokenGrain(token: unknown): WindowGrain {
  return classifySessionId(token).grain;
}

export function stampedWindowGrainOf(ctx: BindableContext): WindowGrain | undefined {
  const stamped = attr(authOf(ctx)?.attributes, ["oe_grain", "oeGrain"]);
  return stamped === "standing" || stamped === "task" || stamped === "native" || stamped === "thread" ? stamped : undefined;
}

export function windowGrainOf(ctx: BindableContext): WindowGrain {
  if (isSubagentChildContext(ctx)) return "task";
  const rawToken = ctx.channel?.continuationToken;
  const stamped = stampedWindowGrainOf(ctx);
  const tokenGrain = classifyTokenGrain(rawToken);
  const tokenPresent = typeof rawToken === "string" && rawToken.length > 0;
  if (stamped !== undefined) {
    if ((stamped === "task" || stamped === "native") && tokenGrain === "standing") return "standing";
    if (stamped === "task" && tokenGrain === "thread") return "thread";
    if (stamped === "task" && tokenGrain === "native" && tokenPresent) return "native";
    return stamped;
  }
  return tokenGrain;
}

export function windowTaskLabelOf(ctx: BindableContext): string | undefined {
  return attr(authOf(ctx)?.attributes, ["oe_task_label"]);
}

export function windowSourcesOf(ctx: BindableContext): readonly string[] | undefined {
  const a = authOf(ctx)?.attributes;
  if (!a) return undefined;
  const decoded = decodeSources(a["oe_sources"] ?? a["oeSources"]);
  return decoded.length > 0 ? decoded : undefined;
}

export function resolveWindowSources(ctx: BindableContext, domains: readonly Domain[]): readonly string[] {
  const stamped = windowSourcesOf(ctx);
  if (stamped) return stamped;
  const tok = ctx.channel?.continuationToken ?? currentWindowToken(ctx);
  const raw = typeof tok === "string" && tok.startsWith("unified:") ? tok.slice("unified:".length) : tok;
  const key = parseWindowToken(raw);
  if (key) {
    const recomputed = sourcesForWindow(key.windowId, key.domain, domains);
    if (recomputed.length > 0) return recomputed;
  }
  const origin = turnOriginPlatform(ctx);
  return origin ? [origin] : [];
}

export function bindBridged(bridged: BridgedIdentity): { platform: string; raw: RawIdentity } {
  const bctx = bridgedContext(bridged);
  const platform = seg(channelPlatform(bctx), "local");
  const raw = (MAPPERS.get(platform) ?? bindLocal)(bctx);
  return { platform, raw };
}

function rawIdentityFrom(ctx: BindableContext): { platform: string; raw: RawIdentity } {
  const platform = seg(channelPlatform(ctx), "local");
  return { platform, raw: (MAPPERS.get(platform) ?? bindLocal)(ctx) };
}

export function carriesPlatformIdentity(ctx: BindableContext): boolean {
  return namesASurface(rawIdentityFrom(ctx).raw);
}

function namesASurface(raw: RawIdentity): boolean {
  return raw.workspace !== undefined || raw.surface !== undefined;
}

export function refreshBindingStamp(ctx: BindableContext): "stamped" | "kept" {
  if (!carriesPlatformIdentity(ctx)) {
    const established = readBindingBridge();
    if (established !== null && namesASurface(bindBridged(established).raw)) return "kept";
  }
  stampBindingBridge(ctx);
  return "stamped";
}

const HOST_STAMP_PREFIXES: readonly string[] = ["oe_", "open_everywhere_"];

function isHostStampKey(key: string): boolean {
  return HOST_STAMP_PREFIXES.some((p) => key.startsWith(p)) || /^oe[A-Z]/.test(key) || /^openEverywhere/.test(key);
}

export type DeliveryHealOutcome = "not-needed" | "healed" | "no-stamp" | "cross-platform" | "no-delivery" | "unwritable";

export function healDeliveryIdentity(ctx: BindableContext): DeliveryHealOutcome {
  try {
    if (carriesPlatformIdentity(ctx)) return "not-needed";
    const bridged = readBindingBridge();
    if (bridged === null) return "no-stamp";
    const hop = bindBridged(bridged);
    if (!namesASurface(hop.raw)) return "no-stamp";
    const platform = seg(channelPlatform(ctx), "local");
    if (MAPPERS.get(platform) !== undefined && hop.platform !== platform) return "cross-platform";
    const auth = authOf(ctx) as { attributes?: Record<string, string | readonly string[]> } | null;
    if (auth === null) return "no-delivery";
    if (auth.attributes === undefined) auth.attributes = {};
    const bag = auth.attributes;
    for (const [key, value] of Object.entries(bridged.attributes)) {
      if (isHostStampKey(key)) continue;
      if (bag[key] !== undefined) continue;
      bag[key] = value;
    }
    return carriesPlatformIdentity(ctx) ? "healed" : "unwritable";
  } catch {
    return "unwritable";
  }
}

export function platformIdentityAttributesFor(ctx: BindableContext, binding: SurfaceBinding): Record<string, string | readonly string[]> | undefined {
  try {
    let platform: string;
    let raw: RawIdentity;
    let attributes: Record<string, unknown> | undefined;
    if (carriesPlatformIdentity(ctx)) {
      ({ platform, raw } = rawIdentityFrom(ctx));
      attributes = (authOf(ctx) as { attributes?: Record<string, unknown> } | null)?.attributes;
    } else {
      const bridged = readBindingBridge();
      if (bridged === null) return undefined;
      ({ platform, raw } = bindBridged(bridged));
      attributes = bridged.attributes as Record<string, unknown> | undefined;
    }
    if (!namesASurface(raw) || attributes === undefined) return undefined;
    if (normalizePlatform(platform) !== normalizePlatform(binding.platform)) return undefined;
    if (raw.workspace !== binding.workspace || raw.surface !== binding.surface) return undefined;
    const out: Record<string, string | readonly string[]> = {};
    for (const [key, value] of Object.entries(attributes)) {
      if (isHostStampKey(key)) continue;
      if (typeof value === "string" || (Array.isArray(value) && value.every((v) => typeof v === "string"))) out[key] = value as string | readonly string[];
    }
    return Object.keys(out).length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

export function subagentBindingLost(ctx: BindableContext): boolean {
  try {
    if (!isSubagentChildContext(ctx)) return false;
    if (delegatedBindingThisTurn(currentTurnId(ctx)) !== undefined) return false;
    if (MAPPERS.get(seg(channelPlatform(ctx), "local")) === undefined) return false;
    if (carriesPlatformIdentity(ctx)) return false;
    const bridged = readBindingBridge();
    return bridged === null || !namesASurface(bindBridged(bridged).raw);
  } catch {
    return false;
  }
}

export function delegatedBindingUnresolved(ctx: BindableContext): "empty" | "no-context" | undefined {
  try {
    if (!isSubagentChildContext(ctx)) return undefined;
    if (delegatedBindingThisTurn(currentTurnId(ctx)) !== undefined) return undefined;
    const state = delegatedSlotState();
    return state === "adopted" ? undefined : state;
  } catch {
    return undefined;
  }
}

export function auditSurfaceModeStamp(binding: Pick<SurfaceBinding, "mode" | "modeResolved">): { readonly surfaceMode?: SessionMode } {
  return binding.modeResolved ? { surfaceMode: binding.mode } : {};
}

export function auditSurfaceModeFrom(ctx: BindableContext): { readonly surfaceMode?: SessionMode } {
  try {
    return auditSurfaceModeStamp(bindFrom(ctx));
  } catch {
    return {};
  }
}

export function bindFrom(ctx: BindableContext): SurfaceBinding {
  if (isUnifiedWindowContext(ctx)) {
    const frozen = frozenSurfaceBindingFrom(ctx);
    if (frozen !== undefined && frozen.org === deploymentOrg() && normalizePlatform(frozen.platform) === channelPlatform(ctx)) return frozen;
  }
  if (isSubagentChildContext(ctx)) {
    const delegated = delegatedBindingThisTurn(currentTurnId(ctx));
    if (delegated !== undefined) return delegated;
    if (!delegatedBindingAdopted()) {
      return {
        org: deploymentOrg(),
        platform: "subagent",
        workspace: UNNAMED_TENANT,
        surface: "unresolved",
        mode: "channel",
        visibility: "private",
        trust: "external",
      };
    }
  }
  let { platform, raw } = rawIdentityFrom(ctx);
  let fire = attestedFirePrincipal(ctx);
  let unattended = unattendedDelivery(ctx);
  if (!namesASurface(raw)) {
    const bridged = readBindingBridge();
    if (bridged) {
      const hop = bindBridged(bridged);
      if (MAPPERS.get(platform) === undefined || hop.platform === platform) {
        ({ platform, raw } = hop);
        fire ??= attestedFirePrincipal(bridgedContext(bridged));
        unattended ||= unattendedDelivery(bridgedContext(bridged));
        console.warn(
          `[open-everywhere:binding-bridge] context carried no platform identity — bound via the session's stamped ${platform} identity`,
        );
      }
    }
  }
  const local = bindLocal(ctx);
  const resolvedMode = raw.mode ?? local.mode;
  const mode = resolvedMode ?? "channel";
  const workspace = seg(raw.workspace ?? ambientWorkspace(), UNNAMED_TENANT);
  const surface = seg(raw.surface ?? ambientSurface(), "default");
  const domainSurfaceSeg = raw.domainSurface ? seg(raw.domainSurface, surface) : undefined;
  const enterpriseSeg = seg(raw.trustEnterprise, "");
  const declared = declaredSurfaceTrust({
    tenantKey: `${platform}/${workspace}`,
    surfaceKeys:
      domainSurfaceSeg !== undefined && domainSurfaceSeg !== surface
        ? [`${platform}/${workspace}/${surface}`, `${platform}/${workspace}/${domainSurfaceSeg}`]
        : [`${platform}/${workspace}/${surface}`],
    ...(trustGroupKey(platform, workspace, raw.trustGroup) ?? {}),
    ...(trustEnterpriseKey(platform, raw.trustEnterprise) ?? {}),
  });
  const vouched = declared === "internal" ? ("internal" as const) : undefined;
  const declaredExternal = mode === "channel" && declared === "public" ? ("external" as const) : undefined;
  const fireTrust: Trust | undefined = fire?.internal === true ? "internal" : undefined;
  let trust = declaredExternal ?? raw.trust ?? fireTrust ?? vouched ?? local.trust ?? (platform === "local" ? "internal" : "external");
  if (
    mode === "dm" &&
    platform !== "local" &&
    getSettings().identity.blanketTrust !== "internal" &&
    !raw.trustVerified &&
    vouched !== "internal" &&
    fire?.internal !== true
  ) {
    trust = "external";
  }
  return {
    org: deploymentOrg(),
    platform,
    workspace,
    surface,
    domainSurface: domainSurfaceSeg !== undefined && domainSurfaceSeg !== surface ? domainSurfaceSeg : undefined,
    mode,
    ...(resolvedMode === undefined ? {} : { modeResolved: true as const }),
    visibility: raw.visibility ?? local.visibility ?? "public",
    trust,
    ...(declared === undefined ? {} : { declaredTrust: declared }),
    ...(enterpriseSeg.length === 0 ? {} : { enterprise: enterpriseSeg }),
    principalId: fire?.id ?? raw.principalId ?? local.principalId,
    ...(fire || unattended ? { principalAttested: true as const } : {}),
    target: raw.target,
    threadTs: raw.threadTs,
    engagementKey: raw.engagementKey,
    roomEngagementKey: raw.roomEngagementKey,
    anchorMessageId: raw.anchorMessageId,
    anchorChannelId: raw.anchorChannelId,
  };
}
