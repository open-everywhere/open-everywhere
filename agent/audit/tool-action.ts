import type { BindableContext } from "../identity/binding.js";
import { bindFrom } from "../identity/binding.js";
import { resolvePartition } from "../memory/partition.js";
import { appendAudit } from "./audit.js";

export async function auditToolAction(
  ctx: BindableContext,
  action: string,
  detail?: Readonly<Record<string, unknown>>,
): Promise<void> {
  try {
    const p = resolvePartition(ctx);
    await appendAudit({
      org: p.org,
      platform: p.platform,
      workspace: p.workspace,
      surface: p.surface,
      principalId: bindFrom(ctx).principalId,
      action,
      detail,
    });
  } catch (err) {
    console.warn(`[open-everywhere:audit] dropped a "${action}" tool-action entry: ${String(err)}`);
  }
}
