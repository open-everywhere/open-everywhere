import { getSettings } from "../settings/settings.js";
import { turnElapsedSeconds } from "../observability/turn-clock.js";

export const FUNCTION_WALL_CEILING_SECONDS = 300;

export const ASSUMED_TURN_ELAPSED_SECONDS = 120;

export const TURN_TAIL_RESERVE_SECONDS = 60;

export const ROUTINE_CARD_WAIT_CEILING_SECONDS = FUNCTION_WALL_CEILING_SECONDS - ASSUMED_TURN_ELAPSED_SECONDS - TURN_TAIL_RESERVE_SECONDS;

export function routineCardWaitCeilingSeconds(elapsedSeconds: number | undefined = turnElapsedSeconds()): number {
  const elapsed = elapsedSeconds !== undefined && Number.isFinite(elapsedSeconds) && elapsedSeconds >= 0 ? elapsedSeconds : ASSUMED_TURN_ELAPSED_SECONDS;
  return FUNCTION_WALL_CEILING_SECONDS - elapsed - TURN_TAIL_RESERVE_SECONDS;
}

export const ROUTINE_CARD_POLL_INTERVAL_MS = 2_000;

export type RoutineCardWaitOutcome =
  | "disarmed"
  | "approved"
  | "declined"
  | "stale"
  | "gone"
  | "unreadable"
  | "deadline";

export interface RoutineCardProbe {
  readonly status: "pending" | "approved" | "rejected" | "expired" | "gone";
  readonly armed: boolean;
}

export interface RoutineCardWaitDeps {
  readonly probe: () => Promise<RoutineCardProbe>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly nowMs: () => number;
  readonly pollIntervalMs?: number;
}

export function routineCardWaitSeconds(): number {
  return getSettings().approvals.routineCardWaitSeconds;
}

export function routineCardWaitBudgetMs(
  configuredSeconds: number = routineCardWaitSeconds(),
  ceilingSeconds: number = routineCardWaitCeilingSeconds(),
): number {
  if (!Number.isFinite(configuredSeconds) || configuredSeconds <= 0) return 0;
  if (!Number.isFinite(ceilingSeconds) || ceilingSeconds <= 0) return 0;
  return Math.min(configuredSeconds, ceilingSeconds) * 1_000;
}

export async function waitForRoutineCardDecision(budgetMs: number, deps: RoutineCardWaitDeps): Promise<RoutineCardWaitOutcome> {
  if (!(budgetMs > 0)) return "disarmed";
  const interval = deps.pollIntervalMs ?? ROUTINE_CARD_POLL_INTERVAL_MS;
  const endsAt = deps.nowMs() + budgetMs;
  let sawUnarmedApproval = false;
  let lastProbeFailed = false;
  for (;;) {
    const probe = await deps.probe().catch(() => undefined);
    lastProbeFailed = probe === undefined;
    switch (probe?.status) {
      case "approved":
        if (probe.armed) return "approved";
        sawUnarmedApproval = true;
        break;
      case "rejected":
        return "declined";
      case "expired":
      case "gone":
        return "gone";
      default:
        break;
    }
    const left = endsAt - deps.nowMs();
    if (left <= 0) return lastProbeFailed ? "unreadable" : sawUnarmedApproval ? "stale" : "deadline";
    await deps.sleep(Math.min(interval, left));
  }
}

export function routineCardWaitRefusalClause(outcome: RoutineCardWaitOutcome, waitedSeconds: number): string {
  switch (outcome) {
    case "declined":
      return " A permission card for this was waiting in the routine's own room, and a person declined it while this run waited — so this run does not get it.";
    case "deadline":
      return ` This run waited ${waitedSeconds}s for someone to answer that card and nobody did, so it was declined for THIS RUN ONLY because nobody was present to action it. The card is still waiting and still clickable — approving it lets future runs do this without asking.`;
    case "stale":
      return ` A person approved the permission card in the routine's own room while this run waited, but no standing permission was written behind their click in the ${waitedSeconds}s this run had, so nothing was armed. A click on a card posted before an \`edit_routine\` records nothing — check whether the instruction changed.`;
    case "gone":
      return " The permission card for this is no longer answerable, so the next run will post a fresh one.";
    case "unreadable":
      return ` A permission card for this is waiting in the routine's own room, but this run could not read it for the last of the ${waitedSeconds}s it waited, so it gave up without knowing whether anyone answered. Nothing here says nobody did. The card is unaffected — approving it still lets future runs do this without asking.`;
    default:
      return "";
  }
}

export function routineCardKeepsStateClause(outcome: RoutineCardWaitOutcome): boolean {
  return outcome === "deadline";
}
