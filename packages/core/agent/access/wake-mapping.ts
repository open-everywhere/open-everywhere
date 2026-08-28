import type { SessionMode } from "./resolver.js";

export type WakeMappingDecision = "proceed" | "unmapped";

export interface WakeMappingInput {
  readonly platform: string;
  readonly mode: SessionMode;
  readonly workspaceId: string | undefined | null;
}

export function classifyWakeMapping(input: WakeMappingInput): WakeMappingDecision {
  if (input.mode !== "channel") return "proceed";
  if (input.platform === "local") return "proceed";
  return typeof input.workspaceId === "string" && input.workspaceId.trim().length > 0 ? "proceed" : "unmapped";
}

export const UNMAPPED_WAKE_DROP_REASON = "channel is not mapped to a domain — workspace unresolved";

export function unmappedWakeCopy(platform: string, channelId: string): string {
  return (
    `⚠️ I can't work in this channel yet — it isn't mapped to a domain, so I can't tell which ${platform} ` +
    `workspace it belongs to (I'd answer from the wrong memory). Operator: add \`${platform}/<workspace-id>/${channelId}\` ` +
    "to a domain's `channels` in `agent/memory/config/domains.ts`, then mention me again."
  );
}
