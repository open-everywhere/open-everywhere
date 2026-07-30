import { MAX_CONSECUTIVE_FAILURES } from "./lifecycle.js";
import { computeNextRun } from "./schedule.js";
import { stallExhausted, stallReason } from "./stall.js";
import type { Routine, RoutineBound, RoutineTrigger } from "./routine.js";

export const DEFAULT_JOB_MAX_DAYS = 7;

export const DEFAULT_JOB_MAX_FIRES = 200;

export const MIN_FIRES_BEFORE_DEADLINE = MAX_CONSECUTIVE_FAILURES;

const DAY_MS = 24 * 60 * 60_000;

function positiveIntEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

export function jobBoundMaxDays(): number {
  return positiveIntEnv("OE_JOB_MAX_DAYS", DEFAULT_JOB_MAX_DAYS);
}

export function jobBoundMaxFires(): number {
  return positiveIntEnv("OE_JOB_MAX_FIRES", DEFAULT_JOB_MAX_FIRES);
}

export function triggerPeriodMs(trigger: RoutineTrigger, from: Date): number | undefined {
  const first = computeNextRun(trigger, from);
  if (!first) return undefined;
  const second = computeNextRun(trigger, first);
  if (!second) return undefined;
  const period = second.getTime() - first.getTime();
  return period > 0 ? period : undefined;
}

export function mintJobBound(trigger: RoutineTrigger, from: Date): RoutineBound {
  const flat = jobBoundMaxDays() * DAY_MS;
  const period = triggerPeriodMs(trigger, from);
  const spanMs = Math.max(flat, period !== undefined ? period * MIN_FIRES_BEFORE_DEADLINE : 0);
  return { until: new Date(from.getTime() + spanMs).toISOString(), maxFires: jobBoundMaxFires() };
}

export function describeBoundPolicy(trigger: RoutineTrigger, from: Date): string {
  const bound = mintJobBound(trigger, from);
  const days = Math.round((Date.parse(bound.until ?? "") - from.getTime()) / DAY_MS);
  return `stops itself after ${bound.maxFires} runs or ${days} day${days === 1 ? "" : "s"}, whichever comes first`;
}

export function describeBound(r: Pick<Routine, "bound" | "fireCount">): string | null {
  const bound = r.bound;
  if (!bound) return null;
  const parts: string[] = [];
  if (bound.maxFires !== undefined) parts.push(`${r.fireCount ?? 0}/${bound.maxFires} runs`);
  if (bound.until !== undefined) parts.push(`until ${bound.until}`);
  return parts.length > 0 ? parts.join(", or ") : null;
}

export type BoundDimension = "fires" | "deadline" | "stalled";

export type BoundVerdict =
  | { readonly exhausted: false }
  | {
      readonly exhausted: true;
      readonly dimension: BoundDimension;
      readonly reason: string;
    };

export function checkBound(
  r: Pick<Routine, "bound" | "fireCount" | "stalledFires">,
  now: Date,
): BoundVerdict {
  const bound = r.bound;
  if (!bound) return { exhausted: false };

  if (stallExhausted(r)) {
    return { exhausted: true, dimension: "stalled", reason: stallReason(r) };
  }

  const fires = Number.isInteger(r.fireCount) && (r.fireCount as number) > 0 ? (r.fireCount as number) : 0;
  if (bound.maxFires !== undefined && fires >= bound.maxFires) {
    return {
      exhausted: true,
      dimension: "fires",
      reason: `it ran ${fires} time${fires === 1 ? "" : "s"} without finishing (its ceiling is ${bound.maxFires} run${bound.maxFires === 1 ? "" : "s"})`,
    };
  }

  if (bound.until !== undefined) {
    const until = Date.parse(bound.until);
    if (Number.isFinite(until) && now.getTime() >= until) {
      return {
        exhausted: true,
        dimension: "deadline",
        reason: `it has been running since before ${bound.until} without finishing (its ceiling is that date)`,
      };
    }
  }

  return { exhausted: false };
}

export function boundExhaustedPatch(verdict: Extract<BoundVerdict, { exhausted: true }>): Partial<Routine> {
  const prefix = verdict.dimension === "stalled" ? "stopped because it was blocked" : "stopped at its ceiling";
  return { status: "disabled", disabledReason: `${prefix} — ${verdict.reason}`, nextRunAt: null };
}
