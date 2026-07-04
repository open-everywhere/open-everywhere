import { defineHook, type HookContext } from "eve/hooks";
import { routineMarker } from "../routines/routine.js";
import { applyOutcome, settleOutcome } from "../routines/lifecycle.js";
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
