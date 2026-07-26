export type RoutineTrigger =
  | { readonly kind: "cron"; readonly expr: string }
  | { readonly kind: "interval"; readonly everyMinutes: number }
  | { readonly kind: "watch"; readonly everyMinutes?: number; readonly expr?: string }
  | { readonly kind: "once"; readonly at: string }
  | {
      readonly kind: "event";
      readonly source: string;
      readonly match?: Readonly<Record<string, string>>;
    };

export type RoutineReport = { readonly kind: "silent" };

export type RoutineStatus = "active" | "disabled" | "done";
export type RunOutcome = "ok" | "failed" | "skipped";

export const JOB_STATE_MAX_BYTES = 16 * 1024;

export interface Routine {
  readonly id: string;
  readonly org: string;
  readonly surfaceKey: string;
  readonly target?: Readonly<Record<string, unknown>>;
  readonly trigger: RoutineTrigger;
  readonly report?: RoutineReport;
  readonly prompt: string;
  readonly createdBy?: string;
  readonly createdAt: string;
  readonly taintedAtCreation?: boolean;

  status: RoutineStatus;
  disabledReason?: string;
  nextRunAt?: string | null;
  lastRunAt?: string;
  lastOutcome?: RunOutcome;
  consecutiveFailures: number;
  lastStateHash?: string;

  sessionMode?: "job";
  jobSessionAnchor?: string;
  jobState?: string;
  jobTainted?: boolean;
  prWatch?: { readonly repo: string; readonly number: number; readonly checksRemaining: number };
  completedAt?: string;
  completedReason?: string;
}

export function isJobRoutine(r: Pick<Routine, "sessionMode">): boolean {
  return r.sessionMode === "job";
}

export function isSilentRoutine(r: Pick<Routine, "report">): boolean {
  return r.report?.kind === "silent";
}

export function assertReportConsistent(trigger: RoutineTrigger, report: RoutineReport | undefined): void {
  if (report?.kind === "silent" && trigger.kind === "watch") {
    throw new Error(
      "A routine can't be both `never` (posts nothing) and only-on-change — a silent watch is just a silent cron. Pick one.",
    );
  }
}

export function isClockScheduled(t: RoutineTrigger): boolean {
  return t.kind === "cron" || t.kind === "interval" || t.kind === "watch" || t.kind === "once";
}

export const ROUTINE_MARKER = {
  id: "open_everywhere_routine_id",
  surface: "open_everywhere_routine_surface",
  org: "open_everywhere_routine_org",
  silent: "open_everywhere_routine_silent",
} as const;

type Attrs = Readonly<Record<string, string | readonly string[]>> | undefined;
function oneOf(v: string | readonly string[] | undefined): string | undefined {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return undefined;
}

export function routineMarker(attributes: Attrs): { id: string; surfaceKey: string; org: string } | null {
  const id = oneOf(attributes?.[ROUTINE_MARKER.id]);
  const surfaceKey = oneOf(attributes?.[ROUTINE_MARKER.surface]);
  const org = oneOf(attributes?.[ROUTINE_MARKER.org]) ?? "default";
  return id && surfaceKey ? { id, surfaceKey, org } : null;
}

export function routineSilentStamped(attributes: Attrs): boolean {
  return oneOf(attributes?.[ROUTINE_MARKER.silent]) === "true";
}

export function describeTrigger(t: RoutineTrigger, report?: RoutineReport): string {
  const silent = report?.kind === "silent";
  switch (t.kind) {
    case "cron":
      return `cron "${t.expr}" (UTC; ${silent ? "posts nothing" : "posts every run"})`;
    case "interval":
      return `every ${t.everyMinutes} min (${silent ? "posts nothing" : "posts every run"})`;
    case "watch":
      return t.expr !== undefined
        ? `cron "${t.expr}" (UTC; posts only on change)`
        : `every ${t.everyMinutes} min (posts only on change)`;
    case "once":
      return `once at ${t.at} (fires once, then disables)`;
    case "event": {
      const m = t.match ? ` ${JSON.stringify(t.match)}` : "";
      return `on ${t.source} event${m}`;
    }
  }
}
