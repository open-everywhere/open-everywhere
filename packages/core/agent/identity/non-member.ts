import type { WakeTrust } from "../channels/wake-envelope.js";
import { declaredSurfaceTrust } from "./trust.js";
import { authorRefutedByRegister, type AuthorTrustQuery } from "./author-trust.js";
import { getSettings } from "../settings/settings.js";

export const OE_CHAT_NONMEMBER_ATTR = "oe_chat_nonmember";

export function nonMemberChatAttrs(nonMember: boolean): Record<string, string> {
  return nonMember ? { [OE_CHAT_NONMEMBER_ATTR]: "true" } : {};
}

export interface IngestedChatMessage {
  readonly trust?: WakeTrust;
  readonly refuted?: boolean;
  readonly authorTrust?: AuthorTrustQuery;
  readonly ungraded?: boolean;
}

const HUMAN_TIERS: ReadonlySet<WakeTrust> = new Set<WakeTrust>(["principal", "peer", "unauth"]);

export function nonMemberChatTrust(m: IngestedChatMessage): boolean {
  if (m.trust === "relay") return false;
  if (m.refuted === true) return true;
  if (m.authorTrust === undefined || m.trust === undefined || !HUMAN_TIERS.has(m.trust)) return false;
  return authorRefutedByRegister(m.authorTrust);
}

export interface ChatWakeRoom {
  readonly surfaceKey?: string;
  readonly groupKey?: string;
  readonly dm?: boolean;
}

export function chatRoomMarks(room: ChatWakeRoom): boolean {
  if (room.dm === true || room.surfaceKey === undefined) return false;
  const segs = room.surfaceKey.split("/");
  if (segs.length < 3) return false;
  const declared = declaredSurfaceTrust({
    tenantKey: segs.slice(0, 2).join("/"),
    surfaceKeys: [room.surfaceKey],
    ...(room.groupKey === undefined ? {} : { groupKey: room.groupKey }),
  });
  if (declared === "public") return true;
  if (declared === "internal") return false;
  return getSettings().identity.undeclaredSurface === "mark";
}

export function chatWakeIngestsNonMember(ingested: readonly IngestedChatMessage[], room: ChatWakeRoom): boolean {
  return chatRoomMarks(room) || ingested.some(nonMemberChatTrust);
}

export function stampNonMemberChatAuth<A extends { attributes?: Record<string, unknown> }>(
  auth: A,
  ingested: readonly IngestedChatMessage[],
  room: ChatWakeRoom,
): A {
  if (!chatWakeIngestsNonMember(ingested, room)) return auth;
  return { ...auth, attributes: { ...(auth.attributes ?? {}), ...nonMemberChatAttrs(true) } };
}
