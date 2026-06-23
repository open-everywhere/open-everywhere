export type RoutineTrigger =
  | { readonly kind: "cron"; readonly expr: string }
  | { readonly kind: "interval"; readonly everyMinutes: number }
  | { readonly kind: "watch"; readonly everyMinutes: number }
  | {
      readonly kind: "event";
      readonly source: string;
      readonly match?: Readonly<Record<string, string>>;
    };

export type RoutineStatus = "active" | "disabled";
export type RunOutcome = "ok" | "failed" | "skipped";

export interface Routine {
  readonly id: string;
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
  return t.kind === "cron" || t.kind === "interval" || t.kind === "watch";
}

export function describeTrigger(t: RoutineTrigger): string {
  switch (t.kind) {
    case "cron":
      return `cron "${t.expr}" (UTC)`;
    case "interval":
      return `every ${t.everyMinutes} min`;
    case "watch":
      return `watch every ${t.everyMinutes} min (posts only on change)`;
    case "event": {
      const m = t.match ? ` ${JSON.stringify(t.match)}` : "";
      return `on ${t.source} event${m}`;
    }
  }
}
