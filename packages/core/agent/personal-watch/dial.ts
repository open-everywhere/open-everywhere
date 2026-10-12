export type WatchDial = "more" | "less" | "none";

export const WATCH_DIALS: readonly WatchDial[] = ["more", "less", "none"];

export const DEFAULT_WATCH_DIAL: WatchDial = "less";

export type WatchUrgency = "later" | "soon" | "urgent";

export const WATCH_URGENCIES: readonly WatchUrgency[] = ["later", "soon", "urgent"];

export interface WatchDialPolicy {
  readonly minUrgency: WatchUrgency | undefined;
  readonly dailyBudget: number;
  readonly minGapMinutes: number;
  readonly checkEveryMinutes: number | undefined;
}

export const WATCH_DIAL_POLICY: Readonly<Record<WatchDial, WatchDialPolicy>> = {
  more: { minUrgency: "later", dailyBudget: 6, minGapMinutes: 60, checkEveryMinutes: 30 },
  less: { minUrgency: "soon", dailyBudget: 2, minGapMinutes: 240, checkEveryMinutes: 120 },
  none: { minUrgency: undefined, dailyBudget: 0, minGapMinutes: 0, checkEveryMinutes: undefined },
};

export const MAX_DAMPENING = WATCH_URGENCIES.length;

export function clampDampening(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(MAX_DAMPENING, Math.max(0, Math.round(value)));
}

export function effectiveMinUrgency(dial: WatchDial, dampening: number): WatchUrgency | undefined {
  const floor = WATCH_DIAL_POLICY[dial].minUrgency;
  if (floor === undefined) return undefined;
  const index = WATCH_URGENCIES.indexOf(floor) + clampDampening(dampening);
  return WATCH_URGENCIES[index];
}

export function urgencyReaches(urgency: WatchUrgency, floor: WatchUrgency): boolean {
  return WATCH_URGENCIES.indexOf(urgency) >= WATCH_URGENCIES.indexOf(floor);
}

export function parseWatchDial(value: unknown): WatchDial | undefined {
  return typeof value === "string" && (WATCH_DIALS as readonly string[]).includes(value) ? (value as WatchDial) : undefined;
}

export const WATCH_QUIET_HOURS_UTC = { startHour: 20, endHour: 7 } as const;

export function inQuietHours(now: Date, quiet: { readonly startHour: number; readonly endHour: number } = WATCH_QUIET_HOURS_UTC): boolean {
  const h = now.getUTCHours();
  return quiet.startHour > quiet.endHour ? h >= quiet.startHour || h < quiet.endHour : h >= quiet.startHour && h < quiet.endHour;
}

export const CALIBRATION_EVERY_NUDGES = 10;
export const CALIBRATION_EVERY_DAYS = 14;

export function calibrationDue(input: { readonly nudgesSinceAsk: number; readonly lastAskedAt: string | undefined; readonly now: Date }): boolean {
  if (input.lastAskedAt === undefined) return true;
  if (input.nudgesSinceAsk + 1 >= CALIBRATION_EVERY_NUDGES) return true;
  const since = input.now.getTime() - Date.parse(input.lastAskedAt);
  return Number.isFinite(since) && since >= CALIBRATION_EVERY_DAYS * 86_400_000 && input.nudgesSinceAsk >= 1;
}
