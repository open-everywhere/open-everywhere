import { defineHook, type HookContext } from "eve/hooks";
import { appendAudit } from "../audit/audit.js";
import { resolvePartition } from "../memory/partition.js";
import { WAKE_TURN_START_ACTION, type WakeTurnStartDetail } from "../channels/wake-timing.js";
import { auditSurfaceModeFrom, currentWakeId, deploymentOrg, type BindableContext } from "../identity/binding.js";
import { optional } from "./control-refusal.js";

async function auditTurnStart(turnId: string | undefined, ctx: HookContext): Promise<void> {
  try {
    const c = ctx as unknown as BindableContext;
    const wakeId = currentWakeId(c);
    if (!wakeId) return;
    const partition = resolvePartition(c);
    const detail: WakeTurnStartDetail = {
      wakeId,
      ...(ctx.session?.id ? { sessionId: ctx.session.id } : {}),
      ...(turnId ? { turnId } : {}),
      turnStartTs: new Date().toISOString(),
    };
    await appendAudit({
      org: deploymentOrg(),
      platform: partition.platform,
      workspace: partition.workspace,
      surface: partition.surfaceKey,
      ...auditSurfaceModeFrom(c),
      action: WAKE_TURN_START_ACTION,
      ts: detail.turnStartTs,
      detail,
    });
  } catch {
  }
}

export default defineHook({
  events: {
    "turn.started": optional("wake-turn-start", async (event, ctx) => {
      await auditTurnStart(event.data.turnId, ctx);
    }),
  },
});
