import type { UnifiedWakeOrigin, WakeOriginCodec } from "@open-everywhere/core/agent/adapter-api.js";

type DiscordOrigin = Extract<UnifiedWakeOrigin, { platform: "discord" }>;

const noColon = (s: string): string => s.replace(/:/g, "_");

const isDmOrigin = (o: DiscordOrigin): o is Extract<DiscordOrigin, { dm: true }> => "dm" in o && o.dm === true;

export const discordWakeOriginCodec: WakeOriginCodec<DiscordOrigin> = {
  validate: (o) => {
    if (typeof o.channelId !== "string" || o.channelId.length === 0) return false;
    if (o.messageId !== undefined && typeof o.messageId !== "string") return false;
    const isDm = o.dm === true && o.guildId === undefined && o.autoThreadName === undefined;
    const isGuild =
      o.dm === undefined &&
      typeof o.guildId === "string" &&
      o.guildId.length > 0 &&
      (o.autoThreadName === undefined || typeof o.autoThreadName === "string");
    return isDm || isGuild;
  },
  threadRef: (origin) =>
    isDmOrigin(origin)
      ? { channelKey: noColon(`discord/dm/${origin.channelId}`), threadKey: noColon(origin.channelId) }
      : { channelKey: noColon(`discord/${origin.guildId}/${origin.channelId}`), threadKey: noColon(origin.channelId) },
  isThreadScoped: () => false,
  containerId: (origin) => origin.channelId,
  dmOrigin: (binding) => {
    if (binding.mode !== "dm" && binding.mode !== "mpim") return undefined;
    const channelId = binding.target?.["channelId"];
    return typeof channelId === "string" && channelId.length > 0 ? { platform: "discord", channelId, dm: true } : undefined;
  },
};
