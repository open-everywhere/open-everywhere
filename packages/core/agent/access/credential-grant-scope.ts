import { bindFrom, unattendedFrom, windowGrainOf, type BindableContext, type WindowGrain } from "../identity/binding.js";
import { domainForChannel } from "../memory/domain.js";
import { domainKeyOf, resolvePartition } from "../memory/partition.js";
import type { CredentialGrantMode, CredentialGrantRow } from "../operational/credential-grant-rows.js";
import { getConfig } from "./config.js";

const GRANT_DOMAIN_KEY_PREFIX = "oe-grant-domain::";

const GRANT_CONVERSATION_GRAIN: WindowGrain = "standing";

export type GrantDomainScopeGate = "unreadable" | "unresolved_mode" | "dm" | "no_domain" | "unattended" | "non_standing_grain";

export type GrantDomainScopeVerdict =
  | { readonly admitted: true; readonly scopeKey: string }
  | { readonly admitted: false; readonly gate: GrantDomainScopeGate; readonly scopeKey?: string };

export function grantDomainScopeVerdict(ctx: BindableContext): GrantDomainScopeVerdict {
  try {
    const binding = bindFrom(ctx);
    if (binding.modeResolved !== true) return { admitted: false, gate: "unresolved_mode" };
    if (binding.mode === "dm" || binding.mode === "mpim") return { admitted: false, gate: "dm" };
    const domain = domainForChannel(domainKeyOf(resolvePartition(ctx)), getConfig().loadDomains());
    if (domain === undefined || domain.name.length === 0) return { admitted: false, gate: "no_domain" };
    const scopeKey = `${GRANT_DOMAIN_KEY_PREFIX}${domain.name}`;
    if (unattendedFrom(binding)) return { admitted: false, gate: "unattended", scopeKey };
    if (windowGrainOf(ctx) !== GRANT_CONVERSATION_GRAIN) return { admitted: false, gate: "non_standing_grain", scopeKey };
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
