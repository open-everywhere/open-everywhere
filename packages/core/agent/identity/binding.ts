import type { SessionMode } from "../access/resolver.js";
import { teamsMode, teamsVisibility, teamsTrust } from "../channels/teams-identity.js";
import { discordMode, discordVisibility } from "../channels/discord-identity.js";
import { telegramMode, telegramVisibility } from "../channels/telegram-identity.js";

export type Visibility = "public" | "private";

export type Trust = "internal" | "external";

export interface SurfaceBinding {
  readonly org: string;
  readonly platform: string;
  readonly workspace: string;
  readonly surface: string;
  readonly mode: SessionMode;
  readonly visibility: Visibility;
  readonly trust: Trust;
  readonly principalId?: string;
  readonly target?: Readonly<Record<string, unknown>>;
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
  readonly mode?: SessionMode;
  readonly visibility?: Visibility;
  readonly trust?: Trust;
  readonly trustVerified?: boolean;
  readonly principalId?: string;
  readonly target?: Readonly<Record<string, unknown>>;
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
    mode,
    visibility: teamsVisibility(scope, membershipType, mode),
    trust: teamsTrust(scope, membershipType, mode, tenantId),
    principalId: authPrincipalId(ctx) ?? attr(a, ["user_id", "userId"]),
    target:
      conversationId && serviceUrl
        ? { serviceUrl, conversationId, tenantId, channelId: attr(a, ["channel_id", "channelId"]), teamId: attr(a, ["team_id", "teamId"]) }
        : undefined,
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
    mode,
    visibility: discordVisibility(everyoneCanView, mode),
    trust: undefined,
    principalId: authPrincipalId(ctx) ?? userId,
    target: channelId ? { channelId } : undefined,
  };
};

const bindTelegram: Mapper = (ctx) => {
  const a = authOf(ctx)?.attributes;
  const chatId = attr(a, ["chat_id", "chatId"]);
  const chatType = attr(a, ["chat_type", "chatType"]);
  const threadId = attr(a, ["message_thread_id", "messageThreadId"]);
  const mode = telegramMode(chatType);
  const chatKey = chatId !== undefined && chatId.startsWith("-") ? `g${chatId.slice(1)}` : chatId;
  const surface = threadId ? `${chatKey}.t${threadId}` : chatKey;
  return {
    workspace: chatKey,
    surface,
    mode,
    visibility: telegramVisibility(chatType, mode),
    trust: undefined,
    principalId: authPrincipalId(ctx) ?? attr(a, ["user_id", "userId"]),
    target: chatId ? { chatId, ...(threadId ? { messageThreadId: Number(threadId) } : {}) } : undefined,
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
  discord: bindDiscord,
  telegram: bindTelegram,
};

export function channelPlatform(ctx: BindableContext): string | undefined {
  const rawKind = ctx.channel?.kind ?? process.env.OE_PLATFORM;
  return rawKind && rawKind.includes(":") ? rawKind.slice(rawKind.lastIndexOf(":") + 1) : rawKind;
}

export function bindFrom(ctx: BindableContext): SurfaceBinding {
  const platform = seg(channelPlatform(ctx), "local");
  const raw = (MAPPERS[platform] ?? bindLocal)(ctx);
  const local = bindLocal(ctx);
  const mode = raw.mode ?? local.mode ?? "channel";
  let trust = raw.trust ?? local.trust ?? (platform === "local" ? "internal" : "external");
  if (mode === "dm" && platform !== "local" && process.env.OE_TRUST !== "internal" && !raw.trustVerified) {
    trust = "external";
  }
  return {
    org: seg(process.env.OE_ORG, "default"),
    platform,
    workspace: seg(raw.workspace ?? local.workspace, "dev"),
    surface: seg(raw.surface ?? local.surface, "default"),
    mode,
    visibility: raw.visibility ?? local.visibility ?? "public",
    trust,
    principalId: raw.principalId ?? local.principalId,
    target: raw.target,
  };
}
