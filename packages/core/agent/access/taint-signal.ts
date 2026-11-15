export {
  untrustedIngestedThisTurn,
  taintKindsThisTurn,
  taintMarkLands,
  OE_TAINTED_FIRE_ATTR,
  taintedFireAttrs,
} from "./deprecated-taint-exports.js";

/** @deprecated OPE-2721: no slot. Does nothing. */
export function markUntrustedIngestedThisTurn(_kind?: string): void {
}

/** @deprecated OPE-2721: no slot. Does nothing. */
export function beginTaintTurn(_turnId: string | undefined): void {
}

/** @deprecated OPE-2721: no slot, so no flip ever fires. Does nothing. */
export function registerTaintFlipObserver(_observer: () => void): void {
}

export {
  /** @deprecated Import from `identity/non-member.ts` (OPE-2711). */
  OE_CHAT_NONMEMBER_ATTR,
  /** @deprecated Import from `identity/non-member.ts` (OPE-2711). */
  nonMemberChatAttrs,
  /** @deprecated Import from `identity/non-member.ts` (OPE-2711). */
  nonMemberChatTrust,
  /** @deprecated Import from `identity/non-member.ts` (OPE-2711). */
  chatRoomMarks,
  /** @deprecated Import from `identity/non-member.ts` (OPE-2711). */
  chatWakeIngestsNonMember,
  /** @deprecated Import from `identity/non-member.ts` (OPE-2711). */
  stampNonMemberChatAuth,
} from "../identity/non-member.js";
export type { IngestedChatMessage, ChatWakeRoom } from "../identity/non-member.js";
