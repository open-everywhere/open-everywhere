import { isTenantScopedPlatform } from "./principal-key.js";
import { MULTI_TENANT_ENV, soleAdmittedTenantFromConfig } from "../access/tenant-admission.js";

export const LINK_TENANT_NONE = "";

export function linkTenantOf(platform: string, tenant?: string | null): string {
  const resolved = tryLinkTenantOf(platform, tenant);
  if (resolved === undefined) throw new Error(linkTenantUnresolvableMessage(platform));
  return resolved;
}

export function tryLinkTenantOf(platform: string, tenant?: string | null): string | undefined {
  if (!isTenantScopedPlatform(platform)) return LINK_TENANT_NONE;
  const given = typeof tenant === "string" ? tenant.trim() : "";
  if (given.length > 0) return given;
  return soleAdmittedTenantFromConfig(platform);
}

export function linkTenantUnresolvableMessage(platform: string): string {
  return (
    `cannot name the ${platform} tenant for this account: on ${platform} a person id is issued PER TENANT, so an ` +
    `identity link has to record which workspace it came from, and this call supplied none. This deployment's config ` +
    `names no single ${platform} tenant either — either it declares no ${platform} channels at all, or it declares more ` +
    `than one (which is only possible with ${MULTI_TENANT_ENV}=1). Fail closed. Fix: add the ${platform} channel for that ` +
    `workspace to agent/memory/domains.ts, or make the call from a surface that names its workspace ` +
    "(identity/link-tenant.ts, OPE-309)."
  );
}
