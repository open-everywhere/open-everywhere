export interface TurnTally {
  readonly ran: readonly string[];
  readonly steps: number;
  readonly handPlaced: boolean;
  readonly wakeId?: string;
}

interface MutableTally {
  ran: string[];
  steps: number;
  handPlaced: boolean;
  wakeId?: string;
}

const MAX_LIVE_TALLIES = 64;

const tallies = new Map<string, MutableTally>();

function tallyKey(sessionId: string, turnId: string): string | undefined {
  if (typeof sessionId !== "string" || sessionId === "" || typeof turnId !== "string" || turnId === "") return undefined;
  return `${sessionId.length}:${sessionId}:${turnId}`;
}

export function openTurnTally(sessionId: string, turnId: string, wakeId?: string): void {
  const key = tallyKey(sessionId, turnId);
  if (key === undefined) return;
  if (tallies.size >= MAX_LIVE_TALLIES) {
    const oldest = tallies.keys().next();
    if (oldest.done === false) tallies.delete(oldest.value);
  }
  tallies.set(key, { ran: [], steps: 0, handPlaced: false, ...(wakeId !== undefined ? { wakeId } : {}) });
}

function liveTally(sessionId: string, turnId: string): MutableTally | undefined {
  const key = tallyKey(sessionId, turnId);
  return key === undefined ? undefined : tallies.get(key);
}

export function recordTallyAction(sessionId: string, turnId: string, toolName: string): void {
  const t = liveTally(sessionId, turnId);
  if (t) t.ran.push(toolName);
}

export function recordTallyStep(sessionId: string, turnId: string): void {
  const t = liveTally(sessionId, turnId);
  if (t) t.steps += 1;
}

export function recordTallyHand(sessionId: string, turnId: string, placed: boolean): void {
  const t = liveTally(sessionId, turnId);
  if (t) t.handPlaced = placed;
}

export function readTurnTally(sessionId: string, turnId: string): TurnTally | null {
  const t = liveTally(sessionId, turnId);
  return t ? { ran: [...t.ran], steps: t.steps, handPlaced: t.handPlaced, ...(t.wakeId !== undefined ? { wakeId: t.wakeId } : {}) } : null;
}

export function closeTurnTally(sessionId: string, turnId: string): void {
  const key = tallyKey(sessionId, turnId);
  if (key !== undefined) tallies.delete(key);
}

export function liveTurnTallyCount(): number {
  return tallies.size;
}

export function resetTurnTalliesForTest(): void {
  tallies.clear();
}
