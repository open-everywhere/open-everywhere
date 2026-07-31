import type { SessionMode } from "../access/resolver.js";
import { readBindingBridge, bridgedContext, type BridgedIdentity } from "./binding-bridge.js";
import { normalizePlatform, platformFromKind } from "./platform.js";
import { admitProviderRegistration } from "../access/provider-selection.js";
import { isVouchedInternal } from "./trust.js";
import { bareTokenFromEveContext, classifySessionId, parseWindowToken, sessionGrantKeyFromToken } from "../channels/window-key.js";
import { sourcesForWindow, decodeSources } from "../channels/window-sources.js";
import { routineGrantKeyStamped } from "../routines/routine.js";
import type { Domain } from "../memory/domain.js";

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
}

interface AuthPrincipal {
  readonly attributes?: Readonly<Record<string, string | readonly string[]>>;
  readonly principalId?: string;
  readonly principalType?: string;
}
export interface BindableContext {
  readonly session?: {
    readonly auth?: {
      readonly current?: AuthPrincipal | null;
      readonly initiator?: AuthPrincipal | null;
    } | null;
  };
  readonly channel?: { readonly kind?: string; readonly continuationToken?: string };
}

const SAFE = /[^a-zA-Z0-9._-]+/g;

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

function authPrincipalId(ctx: BindableContext): string | undefined {
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

export function actingPrincipalId(binding: SurfaceBinding): string | undefined {
  return binding.principalAttested ? undefined : binding.principalId;
}

export interface RawIdentity {
  readonly workspace?: string;
  readonly surface?: string;
  readonly domainSurface?: string;
  readonly mode?: SessionMode;
  readonly visibility?: Visibility;
  readonly trust?: Trust;
  readonly trustVerified?: boolean;
  readonly principalId?: string;
  readonly target?: Readonly<Record<string, unknown>>;
  readonly threadTs?: string;
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

const MAPPERS: Record<string, Mapper> = {};

export function registerIdentityMapper(platform: string, mapper: IdentityMapper): void {
  if (!admitProviderRegistration(platform, "identity-mapper")) return;
  MAPPERS[platform] = mapper;
}

export function channelPlatform(ctx: BindableContext): string | undefined {
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
  return attr(authOf(ctx)?.attributes, ["oe_wake_id", "oeWakeId"]);
}

export function currentTurnId(ctx: BindableContext): string | undefined {
  const turn = (ctx as { session?: { turn?: { id?: string } } }).session?.turn;
  return typeof turn?.id === "string" && turn.id.length > 0 ? turn.id : undefined;
}

export function currentWindowToken(ctx: BindableContext): string | undefined {
  return attr(authOf(ctx)?.attributes, ["oe_window_token", "oeWindowToken"]);
}

export function proposingSessionId(ctx: BindableContext): string | undefined {
  const routineKey = routineGrantKeyStamped(authOf(ctx)?.attributes);
  if (routineKey !== undefined) return routineKey;
  const raw = (ctx as { channel?: { continuationToken?: unknown } }).channel?.continuationToken;
  const token = bareTokenFromEveContext(raw) ?? currentWindowToken(ctx);
  return token === undefined ? undefined : sessionGrantKeyFromToken(token);
}

export function currentTurnAddressing(ctx: BindableContext): string | undefined {
  return attr(authOf(ctx)?.attributes, ["oe_addressing", "oeAddressing"]);
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
  const raw = (MAPPERS[platform] ?? bindLocal)(bctx);
  return { platform, raw };
}

export function bindFrom(ctx: BindableContext): SurfaceBinding {
  let platform = seg(channelPlatform(ctx), "local");
  let raw = (MAPPERS[platform] ?? bindLocal)(ctx);
  let fire = attestedFirePrincipal(ctx);
  let unattended = unattendedOrigin(ctx);
  if (raw.workspace === undefined && raw.surface === undefined) {
    const bridged = readBindingBridge();
    if (bridged) {
      ({ platform, raw } = bindBridged(bridged));
      fire ??= attestedFirePrincipal(bridgedContext(bridged));
      unattended ||= unattendedOrigin(bridgedContext(bridged));
      console.warn(
        `[open-everywhere:binding-bridge] context carried no platform identity — bound via the session's stamped ${platform} identity`,
      );
    }
  }
  const local = bindLocal(ctx);
  const mode = raw.mode ?? local.mode ?? "channel";
  const workspace = seg(raw.workspace ?? local.workspace, "dev");
  const surface = seg(raw.surface ?? local.surface, "default");
  const vouched = isVouchedInternal(`${platform}/${workspace}`, `${platform}/${workspace}/${surface}`)
    ? ("internal" as const)
    : undefined;
  const fireTrust: Trust | undefined = fire?.internal === true ? "internal" : undefined;
  let trust = raw.trust ?? fireTrust ?? vouched ?? local.trust ?? (platform === "local" ? "internal" : "external");
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
    domainSurface:
      raw.domainSurface && seg(raw.domainSurface, surface) !== surface ? seg(raw.domainSurface, surface) : undefined,
    mode,
    visibility: raw.visibility ?? local.visibility ?? "public",
    trust,
    principalId: fire?.id ?? raw.principalId ?? local.principalId,
    ...(fire || unattended ? { principalAttested: true as const } : {}),
    target: raw.target,
    threadTs: raw.threadTs,
  };
}
