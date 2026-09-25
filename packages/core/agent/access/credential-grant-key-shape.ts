export const GRANT_DOMAIN_KEY_PREFIX = "oe-grant-domain::";

export const GRANT_ROOM_KEY_PREFIX = "oe-grant-room::";

export const GRANT_KEY_SEGMENT_SEPARATOR = "::";

export type GrantScopeReach = "session" | "room" | "domain";

export function grantScopeReachOf(domainScopeKey: string | undefined): GrantScopeReach {
  if (domainScopeKey === undefined || domainScopeKey.length === 0) return "session";
  return domainScopeKey.startsWith(GRANT_ROOM_KEY_PREFIX) ? "room" : "domain";
}

export function grantScopeKeyIsConversationStable(scopeKey: string | undefined): boolean {
  if (scopeKey === undefined) return false;
  return scopeKey.startsWith(GRANT_DOMAIN_KEY_PREFIX) || scopeKey.startsWith(GRANT_ROOM_KEY_PREFIX);
}
