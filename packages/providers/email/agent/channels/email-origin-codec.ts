import { normalizeEmailAddress, type UnifiedWakeOrigin, type WakeOriginCodec } from "@open-everywhere/core/agent/adapter-api.js";

type EmailOrigin = Extract<UnifiedWakeOrigin, { platform: "email" }>;

const MAX_STORED_RECIPIENTS = 20;

const noColon = (s: string): string => s.replace(/:/g, "_");

function addressList(v: unknown): readonly string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  if (!v.every((a) => typeof a === "string" && normalizeEmailAddress(a) === a)) return undefined;
  return v as readonly string[];
}

export const emailWakeOriginCodec: WakeOriginCodec<EmailOrigin> = {
  validate: (o) => {
    if (typeof o.inbox !== "string" || normalizeEmailAddress(o.inbox) !== o.inbox) return false;
    if (typeof o.threadId !== "string" || o.threadId.length === 0) return false;
    if (typeof o.messageId !== "string" || o.messageId.length === 0) return false;
    const to = addressList(o.to);
    if (!to || to.length === 0) return false;
    const cc = o.cc === undefined ? [] : addressList(o.cc);
    if (!cc) return false;
    if (to.length + cc.length > MAX_STORED_RECIPIENTS) return false;
    return !to.includes(o.inbox) && !cc.includes(o.inbox);
  },
  threadRef: (o) => ({ channelKey: noColon(`email/${o.inbox}`), threadKey: noColon(o.threadId) }),
  isThreadScoped: () => false,
  containerId: (o) => o.threadId,
};
