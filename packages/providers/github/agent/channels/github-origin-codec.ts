import type { UnifiedWakeOrigin, WakeOriginCodec } from "@open-everywhere/core/agent/adapter-api.js";

type GitHubOrigin = Extract<UnifiedWakeOrigin, { platform: "github" }>;

const noColon = (s: string): string => s.replace(/:/g, "_");

export const githubWakeOriginCodec: WakeOriginCodec<GitHubOrigin> = {
  validate: (o) =>
    typeof o.owner === "string" &&
    o.owner.length > 0 &&
    typeof o.repo === "string" &&
    o.repo.length > 0 &&
    typeof o.issueNumber === "number" &&
    Number.isFinite(o.issueNumber) &&
    o.issueNumber > 0 &&
    (o.installationId === undefined || typeof o.installationId === "number"),
  threadRef: (origin) => ({ channelKey: noColon(`github/${origin.owner}/${origin.repo}`), threadKey: String(origin.issueNumber) }),
  isThreadScoped: () => true,
  containerId: (origin) => `${origin.owner}/${origin.repo}`,
};
