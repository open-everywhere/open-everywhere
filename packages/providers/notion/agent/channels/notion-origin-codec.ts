import type { UnifiedWakeOrigin, WakeOriginCodec } from "@open-everywhere/core/agent/adapter-api.js";

type NotionOrigin = Extract<UnifiedWakeOrigin, { platform: "notion" }>;

const noColon = (s: string): string => s.replace(/:/g, "_");

export const notionWakeOriginCodec: WakeOriginCodec<NotionOrigin> = {
  validate: (o) =>
    typeof o.discussionId === "string" &&
    o.discussionId.length > 0 &&
    (o.pageId === undefined || typeof o.pageId === "string") &&
    (o.workspaceId === undefined || typeof o.workspaceId === "string"),
  threadRef: (origin) => ({ channelKey: noColon(`notion/${origin.pageId ?? origin.discussionId}`), threadKey: noColon(origin.discussionId) }),
  isThreadScoped: () => true,
  containerId: (origin) => origin.discussionId,
};
