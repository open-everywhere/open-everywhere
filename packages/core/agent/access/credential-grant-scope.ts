import { bindFrom, type BindableContext } from "../identity/binding.js";
import { domainForChannel } from "../memory/domain.js";
import { domainKeyOf, resolvePartition } from "../memory/partition.js";
import type { CredentialGrantMode, CredentialGrantRow } from "../operational/credential-grant-rows.js";
import { getConfig } from "./config.js";

const GRANT_DOMAIN_KEY_PREFIX = "oe-grant-domain::";

export function grantDomainScopeKey(ctx: BindableContext): string | undefined {
  try {
    const binding = bindFrom(ctx);
    if (binding.modeResolved !== true) return undefined;
    if (binding.mode === "dm" || binding.mode === "mpim") return undefined;
    const domain = domainForChannel(domainKeyOf(resolvePartition(ctx)), getConfig().loadDomains());
    return domain === undefined || domain.name.length === 0 ? undefined : `${GRANT_DOMAIN_KEY_PREFIX}${domain.name}`;
  } catch {
    return undefined;
  }
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
