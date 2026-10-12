import type { UnifiedWakeOrigin, WakeOriginCodec } from "@open-everywhere/core/agent/adapter-api.js";
import { isMessageNameIn, isSpaceName, isThreadNameIn } from "./google-chat-rest.js";

export type GoogleChatOrigin = Extract<UnifiedWakeOrigin, { platform: "google-chat" }>;

const WORKSPACE_SEGMENT = /^[a-z0-9][a-z0-9-]{0,62}$/u;

const noColon = (s: string): string => s.replace(/:/g, "_");

export const googleChatWakeOriginCodec: WakeOriginCodec<GoogleChatOrigin> = {
  validate: (o) => {
    if (typeof o.workspace !== "string" || !WORKSPACE_SEGMENT.test(o.workspace)) return false;
    if (!isSpaceName(o.space)) return false;
    if (o.thread !== undefined && !isThreadNameIn(o.thread, o.space)) return false;
    if (o.messageName !== undefined && !isMessageNameIn(o.messageName, o.space)) return false;
    if (o.threadReply !== undefined && (o.threadReply !== true || o.thread === undefined)) return false;
    return true;
  },
  threadRef: (o) => ({ channelKey: noColon(`google-chat/${o.space}`), threadKey: noColon(o.thread ?? o.space) }),
  isThreadScoped: (o) => o.threadReply === true,
  containerId: (o) => o.space,
};
