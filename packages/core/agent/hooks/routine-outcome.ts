import { defineHook, type HookContext } from "eve/hooks";
import { routineMarker } from "../routines/routine.js";
import { applyOutcome, settleOutcome } from "../routines/lifecycle.js";
import { auditRoutineDisabled, auditRoutineFire } from "../routines/fire-audit.js";
import { getRoutine, updateRoutine } from "../routines/store.js";

function log(msg: string): void {
  console.log(`[open-everywhere:routines] ${msg}`);
}

async function record(ctx: HookContext, outcome: "ok" | "failed"): Promise<void> {
  const auth = ctx.session?.auth;
  const attrs = auth?.current?.attributes ?? auth?.initiator?.attributes;
  const marker = routineMarker(attrs);
  if (!marker) return;

  try {
    const routine = await getRoutine(marker.org, marker.surfaceKey, marker.id);
    if (!routine) return;
    const settled = settleOutcome(outcome, routine.lastOutcome);
    const updated = applyOutcome(routine, settled, new Date());
    await updateRoutine(marker.org, marker.surfaceKey, marker.id, {
      lastRunAt: updated.lastRunAt,
      lastOutcome: updated.lastOutcome,
      consecutiveFailures: updated.consecutiveFailures,
      status: updated.status,
      disabledReason: updated.disabledReason,
      nextRunAt: updated.nextRunAt,
    });
    const sessionId = typeof ctx.session?.id === "string" && ctx.session.id.length > 0 ? ctx.session.id : undefined;
    if (sessionId !== undefined) {
      await auditRoutineFire(routine, sessionId, settled, {
        consecutiveFailures: updated.consecutiveFailures,
        ...(updated.disabledReason ? { disabledReason: updated.disabledReason } : {}),
      });
    }
    if (updated.status === "disabled" && routine.status !== "disabled") {
      await auditRoutineDisabled(routine, updated.disabledReason ?? "auto-disabled", updated.consecutiveFailures, sessionId);
    }
    log(
      `outcome ${settled} for ${marker.id} [${marker.surfaceKey}] ` +
        `(fails=${updated.consecutiveFailures}${updated.status === "disabled" ? ", AUTO-DISABLED" : ""})`,
    );
  } catch (err) {
    log(`outcome record skipped for ${marker.id}: ${String(err)}`);
  }
}

export default defineHook({
  events: {
    "session.completed": async (_event, ctx) => {
      await record(ctx, "ok");
    },
    "session.failed": async (_event, ctx) => {
      await record(ctx, "failed");
    },
  },
});
