import type { Routine, RunOutcome } from "./routine.js";

export const MAX_CONSECUTIVE_FAILURES = 3;

export function applyOutcome(
  routine: Routine,
  outcome: RunOutcome,
  ranAt: Date,
  maxFailures = MAX_CONSECUTIVE_FAILURES,
): Routine {
  const consecutiveFailures = outcome === "failed" ? routine.consecutiveFailures + 1 : 0;
  const next: Routine = {
    ...routine,
    lastRunAt: ranAt.toISOString(),
    lastOutcome: outcome,
    consecutiveFailures,
  };
  if (outcome === "failed" && consecutiveFailures >= maxFailures) {
    next.status = "disabled";
    next.disabledReason = `auto-disabled after ${consecutiveFailures} consecutive failures`;
    next.nextRunAt = null;
  }
  return next;
}

export function shouldPostOnDiff(prevHash: string | undefined, newHash: string): boolean {
  return prevHash !== newHash;
}

export function hashState(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0");
}

export function gcOrphaned(
  routines: readonly Routine[],
  liveSurfaceKeys: ReadonlySet<string> | null,
): { kept: Routine[]; removed: Routine[] } {
  if (liveSurfaceKeys === null) return { kept: [...routines], removed: [] };
  const kept: Routine[] = [];
  const removed: Routine[] = [];
  for (const r of routines) (liveSurfaceKeys.has(r.surfaceKey) ? kept : removed).push(r);
  return { kept, removed };
}
