import type { UnifiedWakeOrigin, WakeOriginCodec } from "@open-everywhere/core/agent/adapter-api.js";

type SlackOrigin = Extract<UnifiedWakeOrigin, { platform: "slack" }>;

const noColon = (s: string): string => s.replace(/:/g, "_");

export const slackWakeOriginCodec: WakeOriginCodec<SlackOrigin> = {
  validate: (o) =>
    typeof o.channelId === "string" &&
    o.channelId.length > 0 &&
    (o.threadTs === undefined || typeof o.threadTs === "string") &&
    (o.replyAnchorTs === undefined || typeof o.replyAnchorTs === "string"),
  threadRef: (origin) => ({ channelKey: noColon(`slack/${origin.channelId}`), threadKey: noColon(origin.threadTs ?? origin.channelId) }),
  isThreadScoped: (origin) => typeof origin.threadTs === "string" && origin.threadTs.length > 0,
  containerId: (origin) => origin.channelId,
  dmOrigin: (binding) => (binding.surface.length > 0 ? { platform: "slack", channelId: binding.surface, ...(binding.threadTs ? { threadTs: binding.threadTs } : {}) } : undefined),
};
