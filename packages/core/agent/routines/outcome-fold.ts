import { applyOutcome, settleOutcome } from "./lifecycle.js";
import { boundExhaustedPatch, type BoundVerdict } from "./bound.js";
import { auditRoutineDisabled, auditRoutineFire, auditRoutineStalled } from "./fire-audit.js";
import { announceBoundExhausted, announceSelfDisable } from "./disable-notice.js";
import { stallFoldPatch } from "./stall.js";
import { getRoutine, updateRoutine } from "./store.js";
import type { Routine, RunOutcome } from "./routine.js";

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
  readonly manual?: boolean;
  readonly late?: boolean;
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
    lastFailureReason: updated.lastFailureReason,
    consecutiveFailures: updated.consecutiveFailures,
    firstFailureAt: updated.firstFailureAt,
    status: updated.status,
    disabledReason: updated.disabledReason,
    nextRunAt: updated.nextRunAt,
    ...(opts.late === true ? {} : stallFoldPatch(routine)),
  });

  const declared = updated.lastFailureReason;

  if (opts.sessionId !== undefined) {
    await auditRoutineFire(routine, opts.sessionId, settled, {
      consecutiveFailures: updated.consecutiveFailures,
      ...(updated.disabledReason ? { disabledReason: updated.disabledReason } : {}),
      ...(opts.manual === true ? { manual: true } : {}),
      ...(declared !== undefined ? { declaredFailure: declared } : {}),
      ...(opts.late === true ? { late: true } : {}),
    });
  }
  const disabled = updated.status === "disabled" && routine.status !== "disabled" && settled === "failed";
  if (disabled) {
    await auditRoutineDisabled(
      routine,
      updated.disabledReason ?? "auto-disabled",
      updated.consecutiveFailures,
      opts.sessionId,
      declared !== undefined ? { declaredFailure: declared } : {},
    );
    await announceSelfDisable(routine, updated.disabledReason ?? "auto-disabled", updated.consecutiveFailures);
  }
  return { folded: true, outcome: settled, consecutiveFailures: updated.consecutiveFailures, disabled };
}

export async function retireExhaustedRoutine(opts: {
  readonly routine: Routine;
  readonly verdict: Extract<BoundVerdict, { exhausted: true }>;
}): Promise<boolean> {
  const { routine, verdict } = opts;
  const patch = boundExhaustedPatch(verdict);
  const updated = await updateRoutine(routine.org, routine.surfaceKey, routine.id, patch);
  if (!updated) return false;

  await auditRoutineDisabled(routine, patch.disabledReason ?? "stopped at its ceiling", routine.consecutiveFailures, undefined, {
    boundDimension: verdict.dimension,
    fireCount: routine.fireCount ?? 0,
    ...(routine.bound?.maxFires !== undefined ? { maxFires: routine.bound.maxFires } : {}),
    ...(routine.bound?.until !== undefined ? { boundUntil: routine.bound.until } : {}),
    ...(routine.stalledFires ? { stalledFires: routine.stalledFires } : {}),
    ...(routine.lastStallAt !== undefined ? { lastStallAt: routine.lastStallAt } : {}),
  });
  return announceBoundExhausted(routine, verdict);
}

export async function recordCheckpointStall(opts: {
  readonly marker: RoutineOutcomeMarker;
  readonly tool: string;
  readonly reason: string;
  readonly at?: Date;
}): Promise<boolean> {
  const { marker, tool, reason } = opts;
  try {
    const routine = await getRoutine(marker.org, marker.surfaceKey, marker.id);
    if (!routine) return false;
    if (routine.lastStallAt !== undefined) return false;
    const at = (opts.at ?? new Date()).toISOString();
    const updated = await updateRoutine(marker.org, marker.surfaceKey, marker.id, { lastStallAt: at });
    if (!updated) return false;
    await auditRoutineStalled(routine, { tool, reason, stalledFires: (routine.stalledFires ?? 0) + 1 });
    return true;
  } catch (err) {
    console.log(`[open-everywhere:routines] stall record skipped for ${marker.id}: ${String(err)}`);
    return false;
  }
}
