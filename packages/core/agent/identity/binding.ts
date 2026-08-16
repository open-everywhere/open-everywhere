import type { SessionMode } from "../access/resolver.js";
import { readBindingBridge, stampBindingBridge, bridgedContext, type BridgedIdentity } from "./binding-bridge.js";
import { normalizePlatform, platformFromKind } from "./platform.js";
import { admitProviderRegistration } from "../access/provider-selection.js";
import { declaredSurfaceTrust } from "./trust.js";

import { UNNAMED_TENANT } from "./principal-key.js";
import { bareTokenFromEveContext, classifySessionId, parseWindowToken, sessionGrantKeyFromToken } from "../channels/window-key.js";
import { sourcesForWindow, decodeSources } from "../channels/window-sources.js";
import { ROUTINE_MARKER, routineGrantKeyStamped } from "../routines/routine.js";
import type { Domain } from "../memory/domain.js";
import { processRegistryMap } from "../lib/process-registry.js";
import { taskWakeThisTurn, uningressedTurn } from "../access/task-wake-signal.js";

export type Visibility = "public" | "private";

export type Trust = "internal" | "external";

export interface SurfaceBinding {
  readonly org: string;
  readonly platform: string;
  readonly workspace: string;
  readonly surface: string;
  readonly domainSurface?: string;
  readonly mode: SessionMode;
  readonly visibility: Visibility;
  readonly trust: Trust;
  readonly principalId?: string;
  readonly principalAttested?: true;
  readonly target?: Readonly<Record<string, unknown>>;
  readonly threadTs?: string;
  readonly engagementKey?: string;
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

const SAFE = /[^a-zA-Z0-9._-]+/g;

function trustGroupKey(
  platform: string,
  workspace: string,
  group: string | undefined,
): { readonly groupKey: string } | undefined {
  if (group === undefined || !/^[a-zA-Z0-9._-]+:[a-zA-Z0-9._-]+$/.test(group)) return undefined;
  return { groupKey: `${platform}/${workspace}/${group}` };
}


function seg(value: string | undefined, fallback: string): string {
  const cleaned = (value ?? "").trim().replace(SAFE, "-").replace(/^[-.]+|[-.]+$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 100) : fallback;
}

export function deploymentOrg(): string {
  return seg(process.env.OE_ORG, "default");
}

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
  return (
    auth?.authenticator === SCHEDULE_APP_AUTHENTICATOR &&
    auth?.principalId === SCHEDULE_APP_PRINCIPAL_ID &&
    auth?.principalType === SCHEDULE_APP_PRINCIPAL_TYPE
  );
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
  readonly principalId?: string;
  readonly target?: Readonly<Record<string, unknown>>;
  readonly threadTs?: string;
  readonly engagementKey?: string;
}

export type IdentityMapper = (ctx: BindableContext) => RawIdentity;
type Mapper = IdentityMapper;

const ENV_MODES: ReadonlySet<string> = new Set(["channel", "dm", "mpim"]);

const bindLocal: Mapper = (ctx) => {
  const envMode = process.env.OE_MODE;
  const envVis = process.env.OE_VISIBILITY;
  const envTrust = process.env.OE_TRUST;
  return {
    workspace: process.env.OE_WORKSPACE,
    surface: process.env.OE_SURFACE ?? process.env.OE_CHANNEL,
    mode: envMode && ENV_MODES.has(envMode) ? (envMode as SessionMode) : "channel",
    visibility: envVis === "private" ? "private" : "public",
    trust: envTrust === "external" ? "external" : envTrust === "internal" ? "internal" : undefined,
    principalId: authPrincipalId(ctx) ?? process.env.OE_PRINCIPAL,
    target: undefined,
  };
};

const MAPPERS = processRegistryMap<Mapper>("identity-mappers.v1");

export function registerIdentityMapper(platform: string, mapper: IdentityMapper): void {
  if (!admitProviderRegistration(platform, "identity-mapper")) return;
  MAPPERS.set(platform, mapper);
}

export const SUBAGENT_CHANNEL_KIND = "subagent";

export function subagentParentSessionId(ctx: BindableContext): string | undefined {
  const id = ctx.session?.parent?.sessionId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
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

export function channelPlatform(ctx: BindableContext): string | undefined {
  if (platformFromKind(ctx.channel?.kind) === SUBAGENT_CHANNEL_KIND) {
    const inherited = attr(authOf(ctx)?.attributes, ["oe_platform", "oePlatform"]);
    return inherited ? normalizePlatform(inherited) : SUBAGENT_CHANNEL_KIND;
  }
  const kind = platformFromKind(ctx.channel?.kind ?? process.env.OE_PLATFORM);
  if (kind === "unified") {
    const stamped = attr(authOf(ctx)?.attributes, ["oe_platform", "oePlatform"]);
    return stamped ? normalizePlatform(stamped) : kind;
  }
  return kind;
}

export function isUnifiedWindowContext(ctx: BindableContext): boolean {
  return platformFromKind(ctx.channel?.kind) === "unified";
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

export function proposingSessionId(ctx: BindableContext): string | undefined {
  const routineKey = routineGrantKeyStamped(authOf(ctx)?.attributes);
  if (routineKey !== undefined) return routineKey;
  if (isSubagentChildContext(ctx)) {
    const inherited = currentWindowToken(ctx);
    if (inherited !== undefined) return sessionGrantKeyFromToken(inherited);
  }
  const raw = (ctx as { channel?: { continuationToken?: unknown } }).channel?.continuationToken;
  const token = bareTokenFromEveContext(raw) ?? currentWindowToken(ctx);
  return token === undefined ? undefined : sessionGrantKeyFromToken(token);
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

export function assertTurnSurface(ctx: BindableContext, surface: string): void {
  if (!isUnifiedWindowContext(ctx)) return;
  const origin = channelPlatform(ctx);
  if (origin !== surface) {
    throw new Error(
      `this tool reads ${surface}, but the message that woke this turn came from ${origin ?? "another surface"} — ` +
        `on a cross-surface session a per-surface read tool only runs on a turn from its OWN surface (what you can recall across surfaces is the shared context, not another surface's live reads).`,
    );
  }
}

export type WindowGrain = "standing" | "task" | "native" | "thread";

function classifyTokenGrain(token: unknown): WindowGrain {
  return classifySessionId(token).grain;
}

export function windowGrainOf(ctx: BindableContext): WindowGrain {
  if (isSubagentChildContext(ctx)) return "task";
  const rawToken = ctx.channel?.continuationToken;
  const stamped = attr(authOf(ctx)?.attributes, ["oe_grain", "oeGrain"]);
  const tokenGrain = classifyTokenGrain(rawToken);
  const tokenPresent = typeof rawToken === "string" && rawToken.length > 0;
  if (stamped === "standing" || stamped === "task" || stamped === "native" || stamped === "thread") {
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
  const tok = ctx.channel?.continuationToken;
  const raw = typeof tok === "string" && tok.startsWith("unified:") ? tok.slice("unified:".length) : tok;
  const key = parseWindowToken(raw);
  if (key) {
    const recomputed = sourcesForWindow(key.windowId, key.domain, domains);
    if (recomputed.length > 0) return recomputed;
  }
  const origin = channelPlatform(ctx);
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

export function bindFrom(ctx: BindableContext): SurfaceBinding {
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
  const mode = raw.mode ?? local.mode ?? "channel";
  const workspace = seg(raw.workspace ?? local.workspace, UNNAMED_TENANT);
  const surface = seg(raw.surface ?? local.surface, "default");
  const domainSurfaceSeg = raw.domainSurface ? seg(raw.domainSurface, surface) : undefined;
  const declared = declaredSurfaceTrust({
    tenantKey: `${platform}/${workspace}`,
    surfaceKeys:
      domainSurfaceSeg !== undefined && domainSurfaceSeg !== surface
        ? [`${platform}/${workspace}/${surface}`, `${platform}/${workspace}/${domainSurfaceSeg}`]
        : [`${platform}/${workspace}/${surface}`],
    ...(trustGroupKey(platform, workspace, raw.trustGroup) ?? {}),
  });
  const vouched = declared === "internal" ? ("internal" as const) : undefined;
  const declaredExternal = mode === "channel" && declared === "public" ? ("external" as const) : undefined;
  const fireTrust: Trust | undefined = fire?.internal === true ? "internal" : undefined;
  let trust = declaredExternal ?? raw.trust ?? fireTrust ?? vouched ?? local.trust ?? (platform === "local" ? "internal" : "external");
  if (
    mode === "dm" &&
    platform !== "local" &&
    process.env.OE_TRUST !== "internal" &&
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
    visibility: raw.visibility ?? local.visibility ?? "public",
    trust,
    principalId: fire?.id ?? raw.principalId ?? local.principalId,
    ...(fire || unattended ? { principalAttested: true as const } : {}),
    target: raw.target,
    threadTs: raw.threadTs,
    engagementKey: raw.engagementKey,
  };
}
