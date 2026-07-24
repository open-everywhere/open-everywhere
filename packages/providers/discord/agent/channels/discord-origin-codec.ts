import type { UnifiedWakeOrigin, WakeOriginCodec } from "@open-everywhere/core/agent/adapter-api.js";

type DiscordOrigin = Extract<UnifiedWakeOrigin, { platform: "discord" }>;

const noColon = (s: string): string => s.replace(/:/g, "_");

export const discordWakeOriginCodec: WakeOriginCodec<DiscordOrigin> = {
  validate: (o) =>
    typeof o.channelId === "string" &&
    o.channelId.length > 0 &&
    typeof o.guildId === "string" &&
    o.guildId.length > 0 &&
    (o.messageId === undefined || typeof o.messageId === "string") &&
    (o.autoThreadName === undefined || typeof o.autoThreadName === "string"),
  threadRef: (origin) => ({ channelKey: noColon(`discord/${origin.guildId}/${origin.channelId}`), threadKey: noColon(origin.channelId) }),
  isThreadScoped: () => false,
  containerId: (origin) => origin.channelId,
};
