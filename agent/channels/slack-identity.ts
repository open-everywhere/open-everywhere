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
  return { authenticator: "slack", principalId: input.userId, principalType: "slack-user", attributes };
}

export interface ChannelFacts {
  readonly channelType?: string;
  readonly isPrivate?: boolean;
}

export function channelFactsFromRaw(raw: Record<string, unknown>): ChannelFacts {
  const channelType = typeof raw["channel_type"] === "string" ? (raw["channel_type"] as string) : undefined;
  return { channelType };
}

export function channelFactsFromInfo(info: unknown): ChannelFacts {
  const ch = (info as { channel?: Record<string, unknown> } | null)?.channel;
  if (!ch || typeof ch !== "object") return {};
  const isPrivate = typeof ch["is_private"] === "boolean" ? (ch["is_private"] as boolean) : undefined;
  let channelType: string | undefined;
  if (ch["is_im"]) channelType = "im";
  else if (ch["is_mpim"]) channelType = "mpim";
  else if (ch["is_group"] || ch["is_private"]) channelType = "group";
  else if (ch["is_channel"]) channelType = "channel";
  return { channelType, isPrivate };
}
