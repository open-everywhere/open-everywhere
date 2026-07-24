import type { UnifiedThreadRef, UnifiedWakeOrigin } from "./unified-window.js";
import type { WakeOriginCodec } from "./wake-origin-codec.js";

type OriginArm<P extends UnifiedWakeOrigin["platform"]> = Extract<UnifiedWakeOrigin, { platform: P }>;

const noColon = (s: string): string => s.replace(/:/g, "_");

type CoreCodecPlatform = Exclude<UnifiedWakeOrigin["platform"], "notion" | "github" | "teams" | "linear">;

export const wakeOriginCodecs: { readonly [P in CoreCodecPlatform]: WakeOriginCodec<OriginArm<P>> } = {
  slack: {
    validate: (o) =>
      typeof o.channelId === "string" &&
      o.channelId.length > 0 &&
      (o.threadTs === undefined || typeof o.threadTs === "string") &&
      (o.replyAnchorTs === undefined || typeof o.replyAnchorTs === "string"),
    threadRef: (origin) => ({ channelKey: noColon(`slack/${origin.channelId}`), threadKey: noColon(origin.threadTs ?? origin.channelId) }),
    isThreadScoped: (origin) => typeof origin.threadTs === "string" && origin.threadTs.length > 0,
    containerId: (origin) => origin.channelId,
  },
  discord: {
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
  },
};
