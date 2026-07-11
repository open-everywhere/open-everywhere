import { appendAudit } from "../audit/audit.js";
import type { Partition } from "../memory/partition.js";

export type ChatAuditPartition = Pick<Partition, "org" | "platform" | "workspace" | "surface">;

export function shouldAuditChatSilence(reason: string, actedThisTurn: boolean): boolean {
  return !(reason === "empty final message" && actedThisTurn);
}

export async function auditChatSilence(p: ChatAuditPartition, detail: Record<string, unknown>): Promise<void> {
  await appendAudit({
    org: p.org,
    platform: p.platform,
    workspace: p.workspace,
    surface: p.surface,
    action: `${p.platform}.no_reply`,
    detail,
  });
}

export async function auditChatReply(p: ChatAuditPartition, detail: Record<string, unknown>): Promise<void> {
  await appendAudit({
    org: p.org,
    platform: p.platform,
    workspace: p.workspace,
    surface: p.surface,
    action: `${p.platform}.replied`,
    detail,
  });
}
