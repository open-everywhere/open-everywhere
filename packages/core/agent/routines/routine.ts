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

export type RoutineStatus = "active" | "disabled";
export type RunOutcome = "ok" | "failed" | "skipped";

export interface Routine {
  readonly id: string;
  readonly org: string;
  readonly surfaceKey: string;
  readonly target?: Readonly<Record<string, unknown>>;
  readonly trigger: RoutineTrigger;
  readonly prompt: string;
  readonly createdBy?: string;
  readonly createdAt: string;

  status: RoutineStatus;
  disabledReason?: string;
  nextRunAt?: string | null;
  lastRunAt?: string;
  lastOutcome?: RunOutcome;
  consecutiveFailures: number;
  lastStateHash?: string;
}

export function isClockScheduled(t: RoutineTrigger): boolean {
  return t.kind === "cron" || t.kind === "interval" || t.kind === "watch" || t.kind === "once";
}

export const ROUTINE_MARKER = {
  id: "open_everywhere_routine_id",
  surface: "open_everywhere_routine_surface",
  org: "open_everywhere_routine_org",
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

export function describeTrigger(t: RoutineTrigger): string {
  switch (t.kind) {
    case "cron":
      return `cron "${t.expr}" (UTC; posts every run)`;
    case "interval":
      return `every ${t.everyMinutes} min (posts every run)`;
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
