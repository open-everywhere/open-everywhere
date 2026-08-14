import { RUN_FAILURE_REASON_MAX_CHARS, type Routine, type RunOutcome } from "./routine.js";

export const MAX_CONSECUTIVE_FAILURES = 3;

export const MIN_CONSECUTIVE_FAILURE_SPAN_MS = 60 * 60_000;

function failureStreak(routine: Pick<Routine, "consecutiveFailures" | "firstFailureAt" | "lastRunAt">, ranAt: Date): { readonly firstFailureAt: string; readonly spanSatisfied: boolean } {
  if (routine.consecutiveFailures === 0) {
    return { firstFailureAt: ranAt.toISOString(), spanSatisfied: false };
  }
  if (routine.firstFailureAt !== undefined) {
    const startedAt = Date.parse(routine.firstFailureAt);
    if (Number.isFinite(startedAt)) {
      return { firstFailureAt: routine.firstFailureAt, spanSatisfied: ranAt.getTime() - startedAt >= MIN_CONSECUTIVE_FAILURE_SPAN_MS };
    }
  }
  return { firstFailureAt: routine.lastRunAt ?? ranAt.toISOString(), spanSatisfied: true };
}

export function applyOutcome(
  routine: Routine,
  outcome: RunOutcome,
  ranAt: Date,
  maxFailures = MAX_CONSECUTIVE_FAILURES,
): Routine {
  if (routine.status === "done") {
    return {
      ...routine,
      lastRunAt: ranAt.toISOString(),
      lastOutcome: outcome,
      lastFailureReason: outcome === "failed" ? routine.lastFailureReason : undefined,
      nextRunAt: null,
    };
  }
  const failed = outcome === "failed";
  const consecutiveFailures = failed ? routine.consecutiveFailures + 1 : 0;
  const streak = failed ? failureStreak(routine, ranAt) : undefined;
  const next: Routine = {
    ...routine,
    lastRunAt: ranAt.toISOString(),
    lastOutcome: outcome,
    consecutiveFailures,
    firstFailureAt: streak?.firstFailureAt,
    lastFailureReason: failed ? routine.lastFailureReason : undefined,
  };
  if (routine.trigger.kind === "once") {
    next.status = "disabled";
    next.nextRunAt = null;
    next.disabledReason = failed
      ? `auto-disabled — its one scheduled fire failed${next.lastFailureReason ? `: ${next.lastFailureReason}` : ""}`
      : `once: fired and ${outcome} at ${ranAt.toISOString()}`;
  } else if (failed && consecutiveFailures >= maxFailures && streak?.spanSatisfied === true) {
    next.status = "disabled";
    next.disabledReason = `auto-disabled after ${consecutiveFailures} consecutive failures spanning over an hour`;
    next.nextRunAt = null;
  }
  return next;
}

export type JobCompletion =
  | { readonly kind: "completed"; readonly routine: Routine }
  | { readonly kind: "already-done"; readonly routine: Routine }
  | { readonly kind: "not-a-job" };

export function completeJob(routine: Routine, reason: string, at: Date): JobCompletion {
  if (routine.sessionMode !== "job") return { kind: "not-a-job" };
  if (routine.status === "done") return { kind: "already-done", routine };
  const trimmed = reason.trim();
  return {
    kind: "completed",
    routine: {
      ...routine,
      status: "done",
      completedAt: at.toISOString(),
      completedReason: trimmed.length > 0 ? trimmed : "job completed",
      disabledReason: `job completed at ${at.toISOString()}`,
      nextRunAt: null,
    },
  };
}

export function settleOutcome(sessionOutcome: "ok" | "failed", recorded: RunOutcome | undefined): RunOutcome {
  if (recorded === "failed") return "failed";
  return sessionOutcome === "ok" && recorded === "skipped" ? "skipped" : sessionOutcome;
}

export function declareRunFailed(reason: string): { readonly reason: string; readonly patch: Partial<Routine> } {
  const normalised = reason.trim().replace(/\s+/gu, " ").slice(0, RUN_FAILURE_REASON_MAX_CHARS);
  const text = normalised.length > 0 ? normalised : "failure declared with no reason given";
  return { reason: text, patch: { lastOutcome: "failed", lastFailureReason: text } };
}

export function shouldPostOnDiff(prevHash: string | undefined, newHash: string): boolean {
  return prevHash !== newHash;
}

export function hashState(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0");
}

