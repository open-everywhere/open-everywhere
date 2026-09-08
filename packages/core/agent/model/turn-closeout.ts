import { currentSessionId, currentTurnId, type BindableContext } from "../identity/binding.js";
import { durableTurnKey, readTurnState, turnPairKey, writeTurnState, type DurableCloseout } from "./turn-state.js";

export const CLOSEOUT_REFUSAL_LIMIT = 1;

const MAX_TRACKED_CLOSEOUTS = 512;

type CloseoutRecord = DurableCloseout;

const latches = new Map<string, CloseoutRecord>();

function closeoutKey(sessionId: string | undefined, turnId: string): string {
  return turnPairKey(sessionId, turnId);
}

function mergeLatch(key: string, durable: DurableCloseout | undefined): CloseoutRecord | undefined {
  const cached = latches.get(key);
  if (cached === undefined && durable === undefined) return undefined;
  const merged: CloseoutRecord = {
    count: Math.max(cached?.count ?? 0, durable?.count ?? 0),
    reason: cached?.reason ?? durable?.reason ?? "",
    reported: (cached?.reported ?? false) || (durable?.reported ?? false),
  };
  if (merged.reason.length === 0 || merged.count === 0) return undefined;
  remember(key, merged);
  return merged;
}

function remember(key: string, record: CloseoutRecord): void {
  latches.set(key, record);
  if (latches.size > MAX_TRACKED_CLOSEOUTS) {
    const oldest = latches.keys().next();
    if (!oldest.done && oldest.value !== key) latches.delete(oldest.value);
  }
}

export async function noteTurnCloseoutRefusal(ctx: BindableContext, reason: string): Promise<number> {
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
  const rowKey = durableTurnKey(sessionId, turnId);
  const state = rowKey === undefined ? undefined : await readTurnState(rowKey);
  const prior = mergeLatch(key, state?.closeout);
  const merged: CloseoutRecord = {
    count: (prior?.count ?? 0) + 1,
    reason: prior?.reason ?? reason,
    reported: prior?.reported ?? false,
  };
  remember(key, merged);
  if (rowKey !== undefined && state !== undefined) await writeTurnState(rowKey, { ...state, closeout: merged });
  return merged.count;
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

export function turnCloseoutSnapshot(sessionId: string | undefined, turnId: string | undefined): DurableCloseout | undefined {
  if (turnId === undefined || turnId.length === 0) return undefined;
  return latches.get(closeoutKey(sessionId, turnId));
}

export function claimTurnCloseoutReport(
  sessionId: string | undefined,
  turnId: string | undefined,
  durable?: DurableCloseout,
): { reason: string; count: number; first: boolean } | undefined {
  if (turnId === undefined || turnId.length === 0) return undefined;
  const key = closeoutKey(sessionId, turnId);
  const rec = mergeLatch(key, durable);
  if (rec === undefined || rec.count < CLOSEOUT_REFUSAL_LIMIT) return undefined;
  const first = !rec.reported;
  if (first) remember(key, { count: rec.count, reason: rec.reason, reported: true });
  return { reason: rec.reason, count: rec.count, first };
}

export function _resetTurnCloseoutForTest(): void {
  latches.clear();
}
