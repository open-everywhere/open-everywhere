import { rootDmGrainAttrs } from "./unified-window.js";

export interface OpenEverywhereSlackAuth {
  readonly authenticator: string;
  readonly principalId: string;
  readonly principalType: string;
  readonly attributes: Record<string, string>;
}

export interface SlackIdentityInput {
  readonly userId: string;
  readonly teamId?: string;
  readonly channelId: string;
  readonly threadTs?: string;
  readonly channelType?: string;
  readonly isPrivate?: boolean;
  readonly isExternal?: boolean;
  readonly trustChecked?: boolean;
  readonly dmPartnerTrust?: "internal" | "external";
}

export function buildSlackAuth(input: SlackIdentityInput): OpenEverywhereSlackAuth {
  const attributes: Record<string, string> = {
    channel_id: input.channelId,
    user_id: input.userId,
  };
  if (input.teamId) attributes.team_id = input.teamId;
  if (input.threadTs) attributes.thread_ts = input.threadTs;
  if (input.channelType) attributes.channel_type = input.channelType;
  if (typeof input.isPrivate === "boolean") attributes.is_private = String(input.isPrivate);
  if (typeof input.isExternal === "boolean") attributes.is_ext_shared = String(input.isExternal);
  if (typeof input.trustChecked === "boolean") attributes.trust_checked = String(input.trustChecked);
  if (input.dmPartnerTrust) attributes.dm_partner_trust = input.dmPartnerTrust;
  const isDm = input.channelType === "im" || (input.channelType === undefined && input.channelId.startsWith("D"));
  Object.assign(attributes, rootDmGrainAttrs(isDm));
  return { authenticator: "slack", principalId: input.userId, principalType: "slack-user", attributes };
}

export interface ChannelFacts {
  readonly channelType?: string;
  readonly isPrivate?: boolean;
  readonly isExternal?: boolean;
  readonly trustChecked?: boolean;
  readonly dmPartnerTrust?: "internal" | "external";
}

export function partnerFactsFromInfo(info: unknown, expectedTeamId?: string): { dmPartnerTrust: "internal" | "external" } {
  const u = (info as { user?: Record<string, unknown> } | null)?.user;
  if (!u || typeof u !== "object") return { dmPartnerTrust: "external" };
  const guestOrStranger = Boolean(u["is_restricted"] || u["is_ultra_restricted"] || u["is_stranger"]);
  const deletedOrBot = Boolean(u["deleted"] || u["is_bot"]);
  const sameTeam = expectedTeamId ? u["team_id"] === expectedTeamId : true;
  const internal = !guestOrStranger && !deletedOrBot && sameTeam;
  return { dmPartnerTrust: internal ? "internal" : "external" };
}

export function channelFactsFromRaw(raw: Record<string, unknown>): ChannelFacts {
  const channelType = typeof raw["channel_type"] === "string" ? (raw["channel_type"] as string) : undefined;
  return { channelType };
}

export function channelFactsFromInfo(info: unknown): ChannelFacts {
  const ch = (info as { channel?: Record<string, unknown> } | null)?.channel;
  if (!ch || typeof ch !== "object") return {};
  const isPrivate = typeof ch["is_private"] === "boolean" ? (ch["is_private"] as boolean) : undefined;
  const isExternal = Boolean(
    ch["is_ext_shared"] || ch["is_org_shared"] || ch["is_shared"] || ch["is_pending_ext_shared"],
  );
  let channelType: string | undefined;
  if (ch["is_im"]) channelType = "im";
  else if (ch["is_mpim"]) channelType = "mpim";
  else if (ch["is_group"] || ch["is_private"]) channelType = "group";
  else if (ch["is_channel"]) channelType = "channel";
  return { channelType, isPrivate, isExternal, trustChecked: true };
}
