import { currentSessionId, currentTurnId, type BindableContext } from "../identity/binding.js";

export const CLOSEOUT_REFUSAL_LIMIT = 1;

const MAX_TRACKED_CLOSEOUTS = 512;

interface CloseoutRecord {
  count: number;
  readonly reason: string;
  reported: boolean;
}

const latches = new Map<string, CloseoutRecord>();

function closeoutKey(sessionId: string | undefined, turnId: string): string {
  return sessionId !== undefined ? `${sessionId}:${turnId}` : turnId;
}

export function noteTurnCloseoutRefusal(ctx: BindableContext, reason: string): number {
  if (typeof reason !== "string" || reason.length === 0) return 0;
  let turnId: string | undefined;
  let sessionId: string | undefined;
  try {
    turnId = currentTurnId(ctx);
    sessionId = currentSessionId(ctx);
  } catch {
    return 0;
  }
  if (turnId === undefined) return 0;
  const key = closeoutKey(sessionId, turnId);
  const prev = latches.get(key);
  if (prev !== undefined) {
    prev.count += 1;
    return prev.count;
  }
  latches.set(key, { count: 1, reason, reported: false });
  if (latches.size > MAX_TRACKED_CLOSEOUTS) {
    const oldest = latches.keys().next();
    if (!oldest.done) latches.delete(oldest.value);
  }
  return 1;
}

export function turnCloseoutFor(sessionId: string | undefined, turnId: string | undefined): { count: number; reason: string } | undefined {
  if (turnId === undefined || turnId.length === 0) return undefined;
  const rec = latches.get(closeoutKey(sessionId, turnId));
  return rec === undefined ? undefined : { count: rec.count, reason: rec.reason };
}

export function turnCloseoutTripped(sessionId: string | undefined, turnId: string | undefined): boolean {
  const rec = turnCloseoutFor(sessionId, turnId);
  return rec !== undefined && rec.count >= CLOSEOUT_REFUSAL_LIMIT;
}

export function claimTurnCloseoutReport(
  sessionId: string | undefined,
  turnId: string | undefined,
): { reason: string; count: number; first: boolean } | undefined {
  if (turnId === undefined || turnId.length === 0) return undefined;
  const rec = latches.get(closeoutKey(sessionId, turnId));
  if (rec === undefined || rec.count < CLOSEOUT_REFUSAL_LIMIT) return undefined;
  const first = !rec.reported;
  rec.reported = true;
  return { reason: rec.reason, count: rec.count, first };
}

export function _resetTurnCloseoutForTest(): void {
  latches.clear();
}
