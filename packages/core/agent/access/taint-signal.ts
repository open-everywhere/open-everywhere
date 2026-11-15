export {
  untrustedIngestedThisTurn,
  taintKindsThisTurn,
  taintMarkLands,
  OE_TAINTED_FIRE_ATTR,
  taintedFireAttrs,
} from "./deprecated-taint-exports.js";

export function markUntrustedIngestedThisTurn(_kind?: string): void {
}

export function beginTaintTurn(_turnId: string | undefined): void {
}

export function registerTaintFlipObserver(_observer: () => void): void {
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
