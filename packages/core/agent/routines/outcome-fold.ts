import { applyOutcome, settleOutcome } from "./lifecycle.js";
import { auditRoutineDisabled, auditRoutineFire } from "./fire-audit.js";
import { getRoutine, updateRoutine } from "./store.js";
import type { RunOutcome } from "./routine.js";

export interface RoutineOutcomeMarker {
  readonly id: string;
  readonly surfaceKey: string;
  readonly org: string;
}

export interface RoutineOutcomeFold {
  readonly folded: boolean;
  readonly outcome?: RunOutcome;
  readonly consecutiveFailures?: number;
  readonly disabled?: boolean;
}

export async function foldRoutineOutcome(opts: {
  readonly marker: RoutineOutcomeMarker;
  readonly sessionOutcome: "ok" | "failed";
  readonly at?: Date;
  readonly sessionId?: string;
}): Promise<RoutineOutcomeFold> {
  const { marker, sessionOutcome } = opts;
  const at = opts.at ?? new Date();
  const routine = await getRoutine(marker.org, marker.surfaceKey, marker.id);
  if (!routine) return { folded: false };

  const settled = settleOutcome(sessionOutcome, routine.lastOutcome);
  const updated = applyOutcome(routine, settled, at);
  await updateRoutine(marker.org, marker.surfaceKey, marker.id, {
    lastRunAt: updated.lastRunAt,
    lastOutcome: updated.lastOutcome,
    consecutiveFailures: updated.consecutiveFailures,
    status: updated.status,
    disabledReason: updated.disabledReason,
    nextRunAt: updated.nextRunAt,
  });

  if (opts.sessionId !== undefined) {
    await auditRoutineFire(routine, opts.sessionId, settled, {
      consecutiveFailures: updated.consecutiveFailures,
      ...(updated.disabledReason ? { disabledReason: updated.disabledReason } : {}),
    });
  }
  const disabled = updated.status === "disabled" && routine.status !== "disabled";
  if (disabled) {
    await auditRoutineDisabled(routine, updated.disabledReason ?? "auto-disabled", updated.consecutiveFailures, opts.sessionId);
  }
  return { folded: true, outcome: settled, consecutiveFailures: updated.consecutiveFailures, disabled };
}
