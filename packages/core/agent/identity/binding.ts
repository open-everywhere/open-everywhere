import type { SessionMode } from "../access/resolver.js";
import { readBindingBridge, bridgedContext, type BridgedIdentity } from "./binding-bridge.js";
import { normalizePlatform, platformFromKind } from "./platform.js";
import { teamsMode, teamsVisibility, teamsTrust } from "../channels/teams-identity.js";
import { githubVisibility, githubTrust } from "../channels/github-identity.js";
import { discordMode, discordVisibility } from "../channels/discord-identity.js";
import { telegramMode, telegramVisibility, telegramChatKey } from "../channels/telegram-identity.js";
import { notionMode, notionVisibility } from "../channels/notion-identity.js";
import { isVouchedInternal } from "./trust.js";
import { classifySessionId, parseWindowToken } from "../channels/window-key.js";
import { sourcesForWindow, decodeSources } from "../channels/window-sources.js";
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

interface RawIdentity {
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

type Mapper = (ctx: BindableContext) => RawIdentity;

export function slackMode(channelType: string | undefined, channelId: string | undefined): SessionMode {
  if (channelType === "im") return "dm";
  if (channelType === "mpim") return "mpim";
  if (channelType === "channel" || channelType === "group") return "channel";
  if (channelId && channelId.startsWith("D")) return "dm";
  return "channel";
}

export function slackVisibility(
  channelType: string | undefined,
  isPrivate: string | undefined,
  mode: SessionMode,
): Visibility {
  if (isPrivate === "true") return "private";
  if (isPrivate === "false") return "public";
  if (mode === "dm" || mode === "mpim") return "private";
  if (channelType === "channel") return "public";
  return "private";
}

export function slackTrust(
  isExternal: string | undefined,
  trustChecked: string | undefined,
  mode: SessionMode,
): Trust {
  if (mode === "dm" || mode === "mpim") return "internal";
  if (isExternal === "true") return "external";
  if (trustChecked !== "true") return "external";
  return "internal";
}

const bindSlack: Mapper = (ctx) => {
  const a = authOf(ctx)?.attributes;
  const channelId = attr(a, ["channel_id", "channelId"]);
  const channelType = attr(a, ["channel_type", "channelType"]);
  const isPrivate = attr(a, ["is_private", "isPrivate"]);
  const mode = slackMode(channelType, channelId);
  const dmRaw = attr(a, ["dm_partner_trust", "dmPartnerTrust"]);
  const dmPartnerTrust: Trust | undefined = dmRaw === "internal" || dmRaw === "external" ? dmRaw : undefined;
  return {
    workspace: attr(a, ["team_id", "teamId"]),
    surface: channelId,
    mode,
    visibility: slackVisibility(channelType, isPrivate, mode),
    trust: mode === "dm" ? dmPartnerTrust : slackTrust(attr(a, ["is_ext_shared", "isExtShared"]), attr(a, ["trust_checked", "trustChecked"]), mode),
    trustVerified: mode === "dm" ? dmPartnerTrust !== undefined : undefined,
    principalId: authPrincipalId(ctx) ?? attr(a, ["user_id", "userId"]),
    target: channelId ? { channelId } : undefined,
    threadTs: attr(a, ["thread_ts", "threadTs"]),
  };
};

export function linearVisibility(isPrivate: string | undefined): Visibility {
  if (isPrivate === "false") return "public";
  return "private";
}

const bindLinear: Mapper = (ctx) => {
  const a = authOf(ctx)?.attributes;
  const surface =
    attr(a, ["team_id", "teamId"]) ??
    attr(a, ["issue_id", "issueId"]) ??
    attr(a, ["issue_identifier", "issueIdentifier"]) ??
    attr(a, ["agent_session_id", "agentSessionId"]);
  const agentSessionId = attr(a, ["agent_session_id", "agentSessionId"]);
  return {
    workspace: attr(a, ["organization_id", "organizationId"]),
    surface,
    mode: "channel",
    visibility: linearVisibility(attr(a, ["is_private", "isPrivate"])),
    trust: undefined,
    principalId: authPrincipalId(ctx) ?? attr(a, ["creator_id", "creatorId", "user_id", "userId"]),
    target: agentSessionId ? { agentSessionId } : undefined,
  };
};

const bindTeams: Mapper = (ctx) => {
  const a = authOf(ctx)?.attributes;
  const scope = attr(a, ["scope"]);
  const membershipType = attr(a, ["membership_type", "membershipType"]);
  const mode = teamsMode(scope);
  const conversationId = attr(a, ["conversation_id", "conversationId"]);
  const serviceUrl = attr(a, ["service_url", "serviceUrl"]);
  const tenantId = attr(a, ["tenant_id", "tenantId"]);
  return {
    workspace: tenantId,
    surface: conversationId,
    domainSurface: attr(a, ["channel_id", "channelId"]),
    mode,
    visibility: teamsVisibility(scope, membershipType, mode),
    trust: teamsTrust(scope, membershipType, mode, tenantId),
    principalId: authPrincipalId(ctx) ?? attr(a, ["user_id", "userId"]),
    target:
      conversationId && serviceUrl
        ? { serviceUrl, conversationId, tenantId, channelId: attr(a, ["channel_id", "channelId"]), teamId: attr(a, ["team_id", "teamId"]), conversationType: scope }
        : undefined,
  };
};

const bindGitHub: Mapper = (ctx) => {
  const a = authOf(ctx)?.attributes;
  const owner = attr(a, ["owner"]);
  const repo = attr(a, ["repo"]);
  const repoPrivate = attr(a, ["repo_private", "repoPrivate"]);
  const conversationKind = attr(a, ["conversation_kind", "conversationKind"]);
  const issueNumber = attr(a, ["issue_number", "issueNumber"]);
  const pullRequestNumber = attr(a, ["pull_request_number", "pullRequestNumber"]);
  const isPr = conversationKind === "pull_request" || conversationKind === "review_thread";
  const anchor =
    isPr && pullRequestNumber
      ? { pullRequestNumber: Number(pullRequestNumber) }
      : issueNumber
        ? { issueNumber: Number(issueNumber) }
        : pullRequestNumber
          ? { pullRequestNumber: Number(pullRequestNumber) }
          : undefined;
  return {
    workspace: owner,
    surface: repo,
    mode: "channel",
    visibility: githubVisibility(repoPrivate),
    trust: githubTrust(repoPrivate, attr(a, ["author_association", "authorAssociation"])),
    principalId: authPrincipalId(ctx) ?? attr(a, ["user_login", "userLogin", "user_id", "userId"]),
    target: owner && repo && anchor ? { owner, repo, ...anchor } : undefined,
  };
};

const bindDiscord: Mapper = (ctx) => {
  const a = authOf(ctx)?.attributes;
  const channelId = attr(a, ["channel_id", "channelId"]);
  const guildId = attr(a, ["guild_id", "guildId"]);
  const channelType = attr(a, ["channel_type", "channelType"]);
  const everyoneCanView = attr(a, ["everyone_can_view", "everyoneCanView"]);
  const userId = attr(a, ["user_id", "userId"]);
  const mode = discordMode(channelType, guildId);
  return {
    workspace: guildId ?? userId,
    surface: channelId,
    domainSurface: attr(a, ["parent_channel_id", "parentChannelId"]),
    mode,
    visibility: discordVisibility(everyoneCanView, mode),
    trust: undefined,
    principalId: authPrincipalId(ctx) ?? userId,
    target: channelId ? { channelId, ...(guildId ? { guildId } : {}), ...(channelType ? { channelType } : {}) } : undefined,
  };
};

const bindTelegram: Mapper = (ctx) => {
  const a = authOf(ctx)?.attributes;
  const chatId = attr(a, ["chat_id", "chatId"]);
  const chatType = attr(a, ["chat_type", "chatType"]);
  const threadId = attr(a, ["message_thread_id", "messageThreadId"]);
  const mode = telegramMode(chatType);
  const chatKey = chatId !== undefined ? telegramChatKey(chatId) : chatId;
  const surface = threadId ? `${chatKey}.t${threadId}` : chatKey;
  return {
    workspace: chatKey,
    surface,
    mode,
    visibility: telegramVisibility(chatType, mode),
    trust: undefined,
    principalId: authPrincipalId(ctx) ?? attr(a, ["user_id", "userId"]),
    target: chatId ? { chatId, ...(threadId ? { messageThreadId: Number(threadId) } : {}), ...(chatType ? { chatType } : {}) } : undefined,
  };
};

const bindNotion: Mapper = (ctx) => {
  const a = authOf(ctx)?.attributes;
  const workspaceId = attr(a, ["workspace_id", "workspaceId"]);
  const surface =
    attr(a, ["page_id", "pageId"]) ??
    attr(a, ["discussion_id", "discussionId"]) ??
    attr(a, ["comment_id", "commentId"]);
  const discussionId = attr(a, ["discussion_id", "discussionId"]);
  const pageId = attr(a, ["page_id", "pageId"]);
  return {
    workspace: workspaceId,
    surface,
    mode: notionMode(),
    visibility: notionVisibility(),
    trust: undefined,
    principalId: authPrincipalId(ctx) ?? attr(a, ["user_id", "userId"]),
    target: discussionId ? { discussionId, ...(pageId ? { pageId } : {}) } : undefined,
  };
};

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

const MAPPERS: Readonly<Record<string, Mapper>> = {
  slack: bindSlack,
  linear: bindLinear,
  teams: bindTeams,
  github: bindGitHub,
  discord: bindDiscord,
  telegram: bindTelegram,
  notion: bindNotion,
};

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

export function currentWindowToken(ctx: BindableContext): string | undefined {
  return attr(authOf(ctx)?.attributes, ["oe_window_token", "oeWindowToken"]);
}

export function currentTurnAddressing(ctx: BindableContext): string | undefined {
  return attr(authOf(ctx)?.attributes, ["oe_addressing", "oeAddressing"]);
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
  if (raw.workspace === undefined && raw.surface === undefined) {
    const bridged = readBindingBridge();
    if (bridged) {
      ({ platform, raw } = bindBridged(bridged));
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
  let trust = raw.trust ?? vouched ?? local.trust ?? (platform === "local" ? "internal" : "external");
  if (mode === "dm" && platform !== "local" && process.env.OE_TRUST !== "internal" && !raw.trustVerified && vouched !== "internal") {
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
    principalId: raw.principalId ?? local.principalId,
    target: raw.target,
    threadTs: raw.threadTs,
  };
}
