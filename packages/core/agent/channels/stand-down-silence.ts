import { defineState } from "eve/context";
import { durableTurnKey, stoppedAckSpent } from "../model/turn-state.js";

interface StandDownSilence {
  readonly turnId: string;
  readonly silent: true;
}

const slot = defineState<StandDownSilence | null>("open-everywhere.stand-down-silence", () => null);

export const STAND_DOWN_SILENCE_REASON = "stand-down: this turn already posted its acknowledgement into the stopped conversation";

export const REPLY_STAND_DOWN_ACK_ACTION = "reply.stand_down_ack";

export function markStandDownSilenceThisTurn(turnId: string | undefined): void {
  if (turnId === undefined || turnId.length === 0) return;
  try {
    slot.update(() => ({ turnId, silent: true }));
  } catch {
  }
}

export function peekStandDownSilenceThisTurn(turnId: string | undefined): boolean {
  if (turnId === undefined || turnId.length === 0) return false;
  try {
    const cur = slot.get();
    return cur !== null && cur.turnId === turnId;
  } catch {
    return false;
  }
}

export async function standDownSilenceLatchedDurably(sessionId: string | undefined, turnId: string | undefined): Promise<boolean> {
  if (turnId === undefined || turnId.length === 0) return false;
  try {
    const pair = durableTurnKey(sessionId, turnId);
    return pair === undefined ? false : await stoppedAckSpent(pair);
  } catch {
    return false;
  }
}

export function consumeStandDownSilenceThisTurn(turnId: string | undefined): boolean {
  try {
    const cur = slot.get();
    const was = turnId !== undefined && turnId.length > 0 && cur !== null && cur.turnId === turnId;
    slot.update(() => null);
    return was;
  } catch {
    return false;
  }
}
