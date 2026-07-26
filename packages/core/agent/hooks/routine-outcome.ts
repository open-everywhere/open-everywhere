import { defineHook, type HookContext } from "eve/hooks";
import { routineManualStamped, routineMarker } from "../routines/routine.js";
import { foldRoutineOutcome } from "../routines/outcome-fold.js";

function log(msg: string): void {
  console.log(`[open-everywhere:routines] ${msg}`);
}

async function record(ctx: HookContext, outcome: "ok" | "failed"): Promise<void> {
  const auth = ctx.session?.auth;
  const attrs = auth?.current?.attributes ?? auth?.initiator?.attributes;
  const marker = routineMarker(attrs);
  if (!marker) return;

  try {
    const sessionId = typeof ctx.session?.id === "string" && ctx.session.id.length > 0 ? ctx.session.id : undefined;
    const manual = routineManualStamped(attrs);
    const folded = await foldRoutineOutcome({
      marker,
      sessionOutcome: outcome,
      at: new Date(),
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(manual ? { manual: true } : {}),
    });
    if (!folded.folded) return;
    log(
      `outcome ${folded.outcome} for ${marker.id} [${marker.surfaceKey}] ` +
        `(fails=${folded.consecutiveFailures}${folded.disabled ? ", AUTO-DISABLED" : ""})`,
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
