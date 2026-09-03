import { defineState } from "eve/context";
import { readTurnClock } from "../observability/turn-clock.js";
import { MAX_RUN_REFUSALS, noteRoutineRunPermissionRefusal } from "./card-signal.js";
import { describeGrantKind } from "./session-grant.js";

export interface RoutinePermissionCardOffer {
  readonly org: string;
  readonly declaration: string;
  readonly grantKey: string;
  readonly scopeKey: string;
  readonly domain?: string | null;
  readonly requestedBy: string;
  readonly tainted: boolean;
  readonly waitBudgetMs: number;
  readonly grantKind: string;
}

export interface RoutinePermissionCardResult {
  readonly clause: string;
}

export type RoutinePermissionCardOfferer = (offer: RoutinePermissionCardOffer) => Promise<RoutinePermissionCardResult>;

let registered: RoutinePermissionCardOfferer | undefined;

let CARD_POST_TIMEOUT_MS = 8000;

export function routinePermissionCardTimeoutMs(): number {
  return CARD_POST_TIMEOUT_MS;
}

export function _setRoutinePermissionCardTimeoutMsForTest(ms: number): void {
  CARD_POST_TIMEOUT_MS = ms;
}

export function _resetRoutinePermissionCardTimeoutMsForTest(): void {
  CARD_POST_TIMEOUT_MS = 8000;
}

const TIMED_OUT = Symbol("routine-permission-card-post-timeout");

interface CardPostLedger {
  readonly turnId: string;
  readonly posted: number;
}

const cardPosts = defineState<CardPostLedger | null>("open-everywhere.routine-permission-cards-posted", () => null);

function claimCardSlot(): boolean {
  try {
    const turnId = readTurnClock()?.turnId ?? "";
    let allowed = false;
    cardPosts.update((prev) => {
      const posted = prev !== null && prev.turnId === turnId ? prev.posted : 0;
      if (posted >= MAX_RUN_REFUSALS) return { turnId, posted };
      allowed = true;
      return { turnId, posted: posted + 1 };
    });
    return allowed;
  } catch {
    return true;
  }
}

export function registerRoutinePermissionCardOfferer(offerer: RoutinePermissionCardOfferer): void {
  registered = offerer;
}

export function routinePermissionCardOffererRegistered(): boolean {
  return registered !== undefined;
}

export async function offerRoutinePermissionCardFor(offer: RoutinePermissionCardOffer): Promise<RoutinePermissionCardResult> {
  if (registered === undefined) return { clause: "" };
  if (!claimCardSlot()) {
    noteRoutineRunPermissionRefusal({
      permission: describeGrantKind(offer.grantKind),
      card: null,
      cardPosted: false,
      cardKnown: false,
      cardCapped: true,
    });
    return { clause: "" };
  }
  const offerer = registered;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let answer: RoutinePermissionCardResult | typeof TIMED_OUT;
  try {
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), CARD_POST_TIMEOUT_MS);
    });
    answer = await Promise.race([Promise.resolve(offerer(offer)), timeout]);
  } catch {
    return { clause: "" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (answer === TIMED_OUT) {
    console.warn(
      `[open-everywhere:approvals] routine permission card post exceeded ${CARD_POST_TIMEOUT_MS}ms for ${offer.declaration} on ${offer.grantKey}; refused without a card`,
    );
    return { clause: "" };
  }
  return answer;
}
