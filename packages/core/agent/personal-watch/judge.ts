import { WATCH_DIAL_POLICY, effectiveMinUrgency, inQuietHours, urgencyReaches, type WatchDial, type WatchUrgency } from "./dial.js";

export type WatchSilenceReason =
  | "dial-none"
  | "below-dial"
  | "dose-lowered"
  | "quiet-hours"
  | "daily-budget"
  | "min-gap"
  | "read-failed"
  | "unreadable"
  | "dm-stopped"
  | "delivery-refused"
  | "proposal-gap";

export interface WatchFinding {
  readonly kind: string;
  readonly fingerprint: string;
  readonly urgency: WatchUrgency;
  readonly summary: string;
  readonly facts: string;
}

export interface WatchJudgeState {
  readonly dial: WatchDial;
  readonly dampening: number;
  readonly nudgedAt: readonly string[];
}

export type WatchVerdict = { readonly interrupt: true } | { readonly interrupt: false; readonly reason: WatchSilenceReason };

function sameUtcDay(a: Date, b: Date): boolean {
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();
}

export function judgeFinding(finding: Pick<WatchFinding, "urgency">, state: WatchJudgeState, now: Date): WatchVerdict {
  const policy = WATCH_DIAL_POLICY[state.dial];
  if (policy.minUrgency === undefined) return { interrupt: false, reason: "dial-none" };
  if (!urgencyReaches(finding.urgency, policy.minUrgency)) return { interrupt: false, reason: "below-dial" };
  const floor = effectiveMinUrgency(state.dial, state.dampening);
  if (floor === undefined || !urgencyReaches(finding.urgency, floor)) return { interrupt: false, reason: "dose-lowered" };
  if (inQuietHours(now)) return { interrupt: false, reason: "quiet-hours" };
  const today = state.nudgedAt.filter((iso) => sameUtcDay(new Date(iso), now)).length;
  if (today >= policy.dailyBudget) return { interrupt: false, reason: "daily-budget" };
  const last = state.nudgedAt.length > 0 ? Date.parse(state.nudgedAt[state.nudgedAt.length - 1]!) : Number.NaN;
  if (Number.isFinite(last) && now.getTime() - last < policy.minGapMinutes * 60_000) return { interrupt: false, reason: "min-gap" };
  return { interrupt: true };
}
