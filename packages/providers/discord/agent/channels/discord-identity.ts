import type {
  SessionMode,
  Visibility,
  Trust,
  BindableContext,
  IdentityMapper,
  RawIdentity,
} from "@open-everywhere/core/agent/adapter-api.js";
import { rootDmGrainAttrs } from "@open-everywhere/core/agent/adapter-api.js";

export interface OpenEverywhereDiscordAuth {
  readonly authenticator: string;
  readonly principalId: string;
  readonly principalType: string;
  readonly attributes: Record<string, string>;
}

export const DISCORD_CHANNEL_DM = "1";
export const DISCORD_CHANNEL_GROUP_DM = "3";

export interface DiscordIdentityInput {
  readonly userId: string;
  readonly guildId?: string;
  readonly channelId: string;
  readonly channelType?: string;
  readonly everyoneCanView?: boolean;
  readonly parentChannelId?: string;
  readonly memberPending?: boolean;
}

export function buildDiscordAuth(input: DiscordIdentityInput): OpenEverywhereDiscordAuth {
  const attributes: Record<string, string> = {
    channel_id: input.channelId,
    user_id: input.userId,
  };
  if (input.guildId) attributes.guild_id = input.guildId;
  if (input.channelType) attributes.channel_type = input.channelType;
  if (typeof input.everyoneCanView === "boolean") attributes.everyone_can_view = String(input.everyoneCanView);
  if (input.parentChannelId) attributes.parent_channel_id = input.parentChannelId;
  if (typeof input.memberPending === "boolean") attributes.member_pending = String(input.memberPending);
  const dmMode = discordMode(input.channelType, input.guildId);
  Object.assign(attributes, rootDmGrainAttrs(dmMode === "dm" || dmMode === "mpim"));
  return { authenticator: "discord", principalId: input.userId, principalType: "discord-user", attributes };
}

export function threadParentFromRawChannel(raw: Record<string, unknown>): string | undefined {
  const ch = raw["channel"];
  if (ch && typeof ch === "object") {
    const c = ch as Record<string, unknown>;
    const isThread = c["type"] === 10 || c["type"] === 11 || c["type"] === 12;
    const parent = c["parent_id"];
    if (isThread && typeof parent === "string" && parent.length > 0) return parent;
  }
  return undefined;
}

export function discordMode(channelType: string | undefined, guildId: string | undefined): SessionMode {
  if (channelType === DISCORD_CHANNEL_DM) return "dm";
  if (channelType === DISCORD_CHANNEL_GROUP_DM) return "mpim";
  if (guildId && guildId.length > 0) return "channel";
  return "dm";
}

export function discordVisibility(everyoneCanView: string | undefined, mode: SessionMode): Visibility {
  if (mode === "dm" || mode === "mpim") return "private";
  if (everyoneCanView === "true") return "public";
  return "private";
}

export function discordMemberPendingFromRaw(raw: Record<string, unknown>): boolean | undefined {
  const m = raw["member"];
  if (m && typeof m === "object") {
    const p = (m as Record<string, unknown>)["pending"];
    if (typeof p === "boolean") return p;
  }
  return undefined;
}

export function discordTrust(memberPending: string | undefined): Trust | undefined {
  if (memberPending === "true") return "external";
  return undefined;
}

type AuthAttrs = Readonly<Record<string, string | readonly string[]>> | undefined;

function discordAuthOf(ctx: BindableContext): { attributes?: AuthAttrs; principalId?: string } | null {
  return ctx.session?.auth?.current ?? ctx.session?.auth?.initiator ?? null;
}

function discordAttr(a: AuthAttrs, keys: readonly string[]): string | undefined {
  if (!a) return undefined;
  for (const k of keys) {
    const v = a[k];
    if (typeof v === "string" && v.length > 0) return v;
    if (Array.isArray(v) && typeof v[0] === "string" && v[0].length > 0) return v[0];
  }
  return undefined;
}

function discordPrincipalId(ctx: BindableContext): string | undefined {
  const p = discordAuthOf(ctx)?.principalId;
  return p && p.length > 0 ? p : undefined;
}

export const bindDiscord: IdentityMapper = (ctx): RawIdentity => {
  const a = discordAuthOf(ctx)?.attributes;
  const channelId = discordAttr(a, ["channel_id", "channelId"]);
  const guildId = discordAttr(a, ["guild_id", "guildId"]);
  const channelType = discordAttr(a, ["channel_type", "channelType"]);
  const everyoneCanView = discordAttr(a, ["everyone_can_view", "everyoneCanView"]);
  const userId = discordAttr(a, ["user_id", "userId"]);
  const mode = discordMode(channelType, guildId);
  return {
    workspace: guildId ?? userId,
    surface: channelId,
    domainSurface: discordAttr(a, ["parent_channel_id", "parentChannelId"]),
    mode,
    visibility: discordVisibility(everyoneCanView, mode),
    trust: discordTrust(discordAttr(a, ["member_pending", "memberPending"])),
    principalId: discordPrincipalId(ctx) ?? userId,
    ...(mode === "channel" && channelId ? { engagementKey: channelId } : {}),
    target: channelId ? { channelId, ...(guildId ? { guildId } : {}), ...(channelType ? { channelType } : {}) } : undefined,
  };
};
