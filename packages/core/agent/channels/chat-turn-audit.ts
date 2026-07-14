import { appendAudit } from "../audit/audit.js";
import type { Partition } from "../memory/partition.js";

export type ChatAuditPartition = Pick<Partition, "org" | "platform" | "workspace" | "surface">;

function withSessionId(detail: Record<string, unknown>, sessionId: string | undefined): Record<string, unknown> {
  return sessionId ? { ...detail, sessionId } : detail;
}

export async function auditChatReply(p: ChatAuditPartition, detail: Record<string, unknown>, sessionId?: string): Promise<void> {
  await appendAudit({
    org: p.org,
    platform: p.platform,
    workspace: p.workspace,
    surface: p.surface,
    action: `${p.platform}.replied`,
    detail: withSessionId(detail, sessionId),
  });
}
