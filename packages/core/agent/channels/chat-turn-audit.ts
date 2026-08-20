import type { Partition } from "../memory/partition.js";
import { appendAudit } from "../audit/audit.js";

export type ChatAuditPartition = Pick<Partition, "org" | "platform" | "workspace" | "surface">;

export async function auditNoReplySentinelObserved(partition: ChatAuditPartition, sessionId?: string, wakeId?: string): Promise<void> {
  await appendAudit({
    org: partition.org,
    platform: partition.platform,
    workspace: partition.workspace,
    surface: partition.surface,
    action: "reply.no_reply_observed",
    detail: { route: "sentinel", ...(sessionId ? { sessionId } : {}), ...(wakeId ? { wakeId } : {}) },
  });
}
