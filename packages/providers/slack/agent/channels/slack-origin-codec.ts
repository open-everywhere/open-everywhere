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
  carryPlacement: (target, source) =>
    !(target.threadTs && target.threadTs.length > 0) && !(target.replyAnchorTs && target.replyAnchorTs.length > 0) && typeof source.replyAnchorTs === "string" && source.replyAnchorTs.length > 0
      ? { ...target, replyAnchorTs: source.replyAnchorTs }
      : target,
  placementRef: (origin) => (typeof origin.replyAnchorTs === "string" && origin.replyAnchorTs.length > 0 ? origin.replyAnchorTs : undefined),
};
