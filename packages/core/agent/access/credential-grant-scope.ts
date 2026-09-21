import { bindFrom, isSubagentChildContext, stampedWindowGrainOf, unattendedFrom, windowGrainOf, type BindableContext, type WindowGrain } from "../identity/binding.js";
import { domainForChannel, windowedSupervisorEnabled } from "../memory/domain.js";
import { domainKeyOf, resolvePartition } from "../memory/partition.js";
import type { CredentialGrantMode, CredentialGrantRow } from "../operational/credential-grant-rows.js";
import { getConfig } from "./config.js";

const GRANT_DOMAIN_KEY_PREFIX = "oe-grant-domain::";

const GRANT_ROOM_KEY_PREFIX = "oe-grant-room::";

const GRANT_KEY_SEGMENT_SEPARATOR = "::";

const GRANT_CONVERSATION_GRAIN: WindowGrain = "standing";

const GRANT_ROOM_GRAIN: WindowGrain = "native";

export type GrantDomainScopeGate = "unreadable" | "unresolved_mode" | "dm" | "no_domain" | "unattended" | "non_standing_grain" | "ambiguous_domain_name";

export type GrantScopeReach = "session" | "room" | "domain";

export function grantScopeReachOf(domainScopeKey: string | undefined): GrantScopeReach {
  if (domainScopeKey === undefined || domainScopeKey.length === 0) return "session";
  return domainScopeKey.startsWith(GRANT_ROOM_KEY_PREFIX) ? "room" : "domain";
}

export type GrantDomainScopeVerdict =
  | { readonly admitted: true; readonly scopeKey: string }
  | { readonly admitted: false; readonly gate: GrantDomainScopeGate; readonly scopeKey?: string };

export function conversationGrainOf(ctx: BindableContext): WindowGrain {
  if (!isSubagentChildContext(ctx)) return windowGrainOf(ctx);
  return stampedWindowGrainOf(ctx) ?? GRANT_ROOM_GRAIN;
}

export function grantDomainScopeVerdict(ctx: BindableContext): GrantDomainScopeVerdict {
  try {
    const binding = bindFrom(ctx);
    if (binding.modeResolved !== true) return { admitted: false, gate: "unresolved_mode" };
    if (binding.mode === "dm" || binding.mode === "mpim") return { admitted: false, gate: "dm" };
    const roomKey = domainKeyOf(resolvePartition(ctx));
    const domains = getConfig().loadDomains();
    const domain = domainForChannel(roomKey, domains);
    if (domain === undefined || domain.name.length === 0) return { admitted: false, gate: "no_domain" };
    const grain = conversationGrainOf(ctx);
    const roomArm = grain === GRANT_ROOM_GRAIN && !windowedSupervisorEnabled(roomKey, domains);
    if (roomArm && domain.name.includes(GRANT_KEY_SEGMENT_SEPARATOR)) return { admitted: false, gate: "ambiguous_domain_name" };
    const scopeKey = roomArm
      ? `${GRANT_ROOM_KEY_PREFIX}${domain.name}${GRANT_KEY_SEGMENT_SEPARATOR}${roomKey}`
      : `${GRANT_DOMAIN_KEY_PREFIX}${domain.name}`;
    if (unattendedFrom(binding)) return { admitted: false, gate: "unattended", scopeKey };
    if (!roomArm && grain !== GRANT_CONVERSATION_GRAIN) return { admitted: false, gate: "non_standing_grain", scopeKey };
    return { admitted: true, scopeKey };
  } catch {
    return { admitted: false, gate: "unreadable" };
  }
}

export function grantDomainScopeKey(ctx: BindableContext): string | undefined {
  const verdict = grantDomainScopeVerdict(ctx);
  return verdict.admitted ? verdict.scopeKey : undefined;
}

export function grantScopeKeyForMode(mode: CredentialGrantMode, sessionScopeKey: string, domainScopeKey: string | undefined): string {
  return mode === "standing" && domainScopeKey !== undefined && domainScopeKey.length > 0 ? domainScopeKey : sessionScopeKey;
}

export function grantScopeAdmits(
  grant: Pick<CredentialGrantRow, "scopeKey" | "mode">,
  sessionScopeKey: string,
  domainScopeKey: string | undefined,
): boolean {
  if (sessionScopeKey.length > 0 && grant.scopeKey === sessionScopeKey) return true;
  return grant.mode === "standing" && domainScopeKey !== undefined && domainScopeKey.length > 0 && grant.scopeKey === domainScopeKey;
}
