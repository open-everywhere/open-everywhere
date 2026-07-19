import { defineState } from "eve/context";

export const REPEAT_NUDGE_THRESHOLD = 3;

export const REPEAT_HARD_THRESHOLD = 5;

const HASH_PREFIX_CHARS = 4096;

export function hashResultBody(body: string): string {
  const sample = body.length > HASH_PREFIX_CHARS ? body.slice(0, HASH_PREFIX_CHARS) : body;
  let h = 0x811c9dc5;
  for (let i = 0; i < sample.length; i++) {
    h ^= sample.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return `${body.length.toString(16)}:${h.toString(16)}`;
}

export function loopKey(source: string | undefined, body: string): string {
  return `${source ?? ""} ${hashResultBody(body)}`;
}

export function recordAndCount(counts: Map<string, number>, source: string | undefined, body: string): number {
  const key = loopKey(source, body);
  const next = (counts.get(key) ?? 0) + 1;
  counts.set(key, next);
  return next;
}

export function nudgeForCount(source: string | undefined, count: number): string | null {
  if (count < REPEAT_NUDGE_THRESHOLD) return null;
  const what = source ? `\`${source}\`` : "this tool";
  if (count >= REPEAT_HARD_THRESHOLD) {
    return (
      `⛔ LOOP BREAKER: ${what} has now returned the IDENTICAL result ${count} times this turn — ` +
      `it is deterministically failing and CANNOT change by retrying. STOP calling it. End your turn ` +
      `now: report the failure (what you tried, why it can't succeed here) to the person, or answer ` +
      `from what you already have. Do not call ${what} again this turn.`
    );
  }
  return (
    `⚠️ LOOP BREAKER: ${what} has returned the same result ${count} times this turn — it looks ` +
    `deterministic-failing, so retrying it will not help. Stop retrying; report the blocker or ` +
    `proceed with what you have instead.`
  );
}

const slot = defineState<Map<string, number> | null>("open-everywhere.loop-breaker-turn", () => null);

export function noteToolResultLoop(source: string | undefined, body: string): string | null {
  try {
    const counts = slot.get() ?? new Map<string, number>();
    const count = recordAndCount(counts, source, body);
    slot.update(() => counts);
    return nudgeForCount(source, count);
  } catch {
    return null;
  }
}

export function resetLoopBreakerTurn(): void {
  try {
    slot.update(() => new Map<string, number>());
  } catch {
  }
}
