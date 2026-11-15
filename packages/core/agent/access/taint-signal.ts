import { defineState } from "eve/context";
import type { IngestionKind } from "./taint-tiers.js";
import { taintEnabled } from "./taint-enforcement.js";

interface TaintState {
  readonly turn?: string;
  readonly tainted: boolean;
  readonly kinds?: readonly string[];
}

const slot = defineState<TaintState>("open-everywhere.untrusted-ingested", () => ({ tainted: false }));

function readState(v: unknown): TaintState {
  if (v === true) return { tainted: true };
  if (v === false || v === undefined || v === null) return { tainted: false };
  if (typeof v === "object" && "tainted" in (v as Record<string, unknown>)) {
    const s = v as { turn?: unknown; tainted?: unknown; kinds?: unknown };
    const kinds = Array.isArray(s.kinds) ? s.kinds.filter((k): k is string => typeof k === "string") : [];
    return {
      turn: typeof s.turn === "string" ? s.turn : undefined,
      tainted: s.tainted === true,
      ...(kinds.length > 0 ? { kinds } : {}),
    };
  }
  return { tainted: false };
}

export function beginTaintTurn(turnId: string | undefined): void {
  try {
    slot.update((cur) => {
      const state = readState(cur);
      if (turnId === undefined) return state;
      if (state.turn === turnId) return state;
      return { turn: turnId, tainted: false };
    });
  } catch {
  }
}

export function markUntrustedIngestedThisTurn(kind?: IngestionKind): void {
  if (!taintEnabled()) return;
  let flipped = false;
  try {
    slot.update((cur) => {
      const state = readState(cur);
      const kinds = state.kinds ?? [];
      const nextKinds = kind !== undefined && !kinds.includes(kind) ? [...kinds, kind] : kinds;
      if (state.tainted && nextKinds.length === kinds.length) return state;
      if (!state.tainted) flipped = true;
      return { turn: state.turn, tainted: true, ...(nextKinds.length > 0 ? { kinds: nextKinds } : {}) };
    });
  } catch {
  }
  if (flipped) notifyTaintFlipped();
}

type TaintFlipObserver = () => void;

const flipObservers: TaintFlipObserver[] = [];

export function registerTaintFlipObserver(observer: TaintFlipObserver): void {
  flipObservers.push(observer);
}

function notifyTaintFlipped(): void {
  for (const observer of flipObservers) {
    try {
      observer();
    } catch {
    }
  }
}

export function untrustedIngestedThisTurn(): boolean {
  if (!taintEnabled()) return false;
  try {
    return readState(slot.get()).tainted;
  } catch {
    return false;
  }
}

export function taintMarkLands(): boolean {
  try {
    slot.get();
    return true;
  } catch {
    return false;
  }
}

export function taintKindsThisTurn(): readonly string[] {
  if (!taintEnabled()) return [];
  try {
    return readState(slot.get()).kinds ?? [];
  } catch {
    return [];
  }
}

export const OE_TAINTED_FIRE_ATTR = "oe_tainted_fire";

export function taintedFireAttrs(tainted: boolean): Record<string, string> {
  return tainted ? { [OE_TAINTED_FIRE_ATTR]: "true" } : {};
}

export {
  OE_CHAT_NONMEMBER_ATTR,
  nonMemberChatAttrs,
  nonMemberChatTrust,
  chatRoomMarks,
  chatWakeIngestsNonMember,
  stampNonMemberChatAuth,
} from "../identity/non-member.js";
export type { IngestedChatMessage, ChatWakeRoom } from "../identity/non-member.js";
