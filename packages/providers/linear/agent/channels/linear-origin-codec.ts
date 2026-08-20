import type { UnifiedWakeOrigin, WakeOriginCodec } from "@open-everywhere/core/agent/adapter-api.js";

type LinearOrigin = Extract<UnifiedWakeOrigin, { platform: "linear" }>;

const noColon = (s: string): string => s.replace(/:/g, "_");

export const linearWakeOriginCodec: WakeOriginCodec<LinearOrigin> = {
  validate: (o) => {
    if (typeof o.issueId !== "string" || o.issueId.length === 0) return false;
    if (o.parentId !== undefined && typeof o.parentId !== "string") return false;
    if (o.organizationId !== undefined && typeof o.organizationId !== "string") return false;
    const isAmbient = o.ambient === true && o.agentSessionId === undefined;
    const isMention = o.ambient === undefined && typeof o.agentSessionId === "string" && o.agentSessionId.length > 0;
    return isAmbient || isMention;
  },
  threadRef: (origin) => ({ channelKey: noColon(`linear/${origin.issueId}`), threadKey: noColon(origin.parentId ?? origin.issueId) }),
  isThreadScoped: () => true,
  containerId: (origin) => origin.issueId,
};
