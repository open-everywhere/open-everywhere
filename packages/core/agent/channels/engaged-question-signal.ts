import { defineState } from "eve/context";
import { engagedQuestionWake } from "./engaged-wake.js";

interface EngagedQuestionState {
  readonly turn?: string;
  readonly deliveries?: readonly string[];
  readonly asks?: boolean;
}

const slot = defineState<EngagedQuestionState>("open-everywhere.engaged-question", () => ({}));

const MAX_DELIVERIES = 2;

/**
 * Notes this turn's distinct deliveries and whether the FIRST one is an engaged follow-up that asks
 * a question. The `delivery.consumed` hook calls it once per delivered message. A turn holds the
 * mark only while exactly one distinct delivery came in: a second delivery in the same turn (a work
 * settlement, a sign-in note, a coalesced wake) clears it, so a batch leaves every silence reason
 * open. A re-run of the hook for the SAME delivery id changes nothing. A delivery with no id is
 * keyed by its text, so the record stays deterministic on a replay.
 */
export function recordEngagedQuestionThisTurn(
  turnId: string | undefined,
  deliveryId: string | undefined,
  delivered: string | undefined,
): void {
  if (turnId === undefined || turnId.length === 0) return;
  try {
    const asks = engagedQuestionWake(delivered);
    const id = deliveryId !== undefined && deliveryId.length > 0 ? deliveryId : `text:${(delivered ?? "").slice(0, 200)}`;
    slot.update((cur) => {
      const same = cur !== null && typeof cur === "object" && cur.turn === turnId;
      const prior = same ? (cur.deliveries ?? []) : [];
      if (prior.includes(id)) return cur;
      const deliveries = [...prior, id].slice(0, MAX_DELIVERIES);
      return { turn: turnId, deliveries, asks: prior.length === 0 ? asks : false };
    });
  } catch {
  }
}

export function engagedQuestionThisTurn(turnId: string | undefined): boolean {
  if (turnId === undefined || turnId.length === 0) return false;
  try {
    const cur = slot.get();
    return cur.turn === turnId && cur.deliveries?.length === 1 && cur.asks === true;
  } catch {
    return false;
  }
}
