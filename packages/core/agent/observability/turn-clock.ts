import { defineState } from "eve/context";

export interface TurnClock {
  readonly turnId: string;
  readonly sessionId: string;
  readonly startedAt: number;
  steps: number;
  tokens: number;
}

const turnSlot = defineState<TurnClock | null>("open-everywhere.telemetry-turn", () => null);

export function readTurnClock(): TurnClock | null {
  try {
    return turnSlot.get();
  } catch {
    return null;
  }
}

export function resetTurnClock(turnId: string, startedAt: number, sessionId: string): void {
  try {
    turnSlot.update(() => ({ turnId, sessionId, startedAt, steps: 0, tokens: 0 }));
  } catch {
  }
}

export function bumpTurnClock(deltaTokens: number): void {
  try {
    turnSlot.update((prev) => {
      const base = prev ?? { turnId: "", sessionId: "", startedAt: Date.now(), steps: 0, tokens: 0 };
      return { ...base, steps: base.steps + 1, tokens: base.tokens + deltaTokens };
    });
  } catch {
  }
}

export function turnElapsedSeconds(nowMs: number = Date.now()): number | undefined {
  const turn = readTurnClock();
  if (!turn) return undefined;
  const elapsed = (nowMs - turn.startedAt) / 1_000;
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : undefined;
}
