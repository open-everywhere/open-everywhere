import { MAX_CONSECUTIVE_FAILURES } from "./lifecycle.js";
import type { Routine } from "./routine.js";

export const MAX_STALLED_FIRES: number = MAX_CONSECUTIVE_FAILURES;

export function stallExhausted(r: Pick<Routine, "stalledFires">): boolean {
  const n = r.stalledFires;
  return Number.isInteger(n) && (n as number) >= MAX_STALLED_FIRES;
}

export function stallReason(r: Pick<Routine, "stalledFires">): string {
  const n = Number.isInteger(r.stalledFires) ? (r.stalledFires as number) : 0;
  return (
    `it was blocked on ${n} run${n === 1 ? "" : "s"} in a row by a session cost checkpoint whose ` +
    `confirmation nobody gave (its limit is ${MAX_STALLED_FIRES} blocked run${MAX_STALLED_FIRES === 1 ? "" : "s"})`
  );
}

export function describeStall(r: Pick<Routine, "stalledFires" | "lastStallAt">): string | null {
  const n = Number.isInteger(r.stalledFires) ? (r.stalledFires as number) : 0;
  if (n <= 0) return null;
  return (
    `blocked on a cost checkpoint: ${n}/${MAX_STALLED_FIRES} run${n === 1 ? "" : "s"}` +
    (r.lastStallAt !== undefined ? ` (last ${r.lastStallAt})` : "")
  );
}

export function stallFoldPatch(r: Pick<Routine, "stalledFires" | "lastStallAt">): Partial<Routine> {
  if (r.lastStallAt !== undefined) {
    const n = Number.isInteger(r.stalledFires) && (r.stalledFires as number) > 0 ? (r.stalledFires as number) : 0;
    return { stalledFires: n + 1 };
  }
  return r.stalledFires !== undefined ? { stalledFires: undefined } : {};
}

export function stallResetPatch(): Partial<Routine> {
  return { stalledFires: undefined, lastStallAt: undefined };
}
