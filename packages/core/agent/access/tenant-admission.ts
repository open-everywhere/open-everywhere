import { getConfig } from "./config.js";
import { isTenantScopedPlatform, principalKeyReplacementHint } from "../identity/principal-key.js";
import type { Domain } from "../memory/domain.js";

export const MULTI_TENANT_ENV = "OE_ALLOW_MULTI_TENANT_PRINCIPALS";

export function multiTenantPrincipalsAllowed(): boolean {
  return process.env[MULTI_TENANT_ENV] === "1";
}

export function admittedTenants(platform: string, domains: readonly Domain[]): ReadonlySet<string> {
  const admitted = new Set<string>();
  const prefix = `${platform}/`;
  for (const d of domains) {
    for (const key of d.reach ?? []) {
      if (!key.startsWith(prefix)) continue;
      const tenant = key.slice(prefix.length).split("/")[0];
      if (tenant) admitted.add(tenant);
    }
  }
  return admitted;
}

export function admittedTenantsFromConfig(platform: string): ReadonlySet<string> {
  try {
    return admittedTenants(platform, getConfig().loadDomains());
  } catch {
    return new Set();
  }
}

export function soleAdmittedTenant(platform: string, domains: readonly Domain[]): string | undefined {
  const tenants = admittedTenants(platform, domains);
  return tenants.size === 1 ? [...tenants][0] : undefined;
}

export function soleAdmittedTenantFromConfig(platform: string): string | undefined {
  try {
    return soleAdmittedTenant(platform, getConfig().loadDomains());
  } catch {
    return undefined;
  }
}

export function assertSingleTenantPerTenantScopedPlatform(domains: readonly Domain[]): void {
  if (multiTenantPrincipalsAllowed()) return;
  const platforms = new Set<string>();
  for (const d of domains) {
    for (const key of d.reach ?? []) {
      const platform = key.split("/")[0];
      if (platform && isTenantScopedPlatform(platform)) platforms.add(platform);
    }
  }
  const bad: string[] = [];
  for (const platform of [...platforms].sort()) {
    const tenants = [...admittedTenants(platform, domains)].sort();
    if (tenants.length > 1) {
      bad.push(
        `  "${platform}" declares ${tenants.length} tenants (${tenants.map((t) => JSON.stringify(t)).join(", ")}). ` +
          `On ${platform} a person id is issued PER TENANT, but a principal key is only \`${platform}/<id>\` — so two workspaces' members ` +
          `share one key, and every matcher over it (admin rosters, wake trust, approval clickers, a DM's personal credentials) can hand one ` +
          `person another's standing on a chance id collision. Keep one ${platform} tenant per deployment, or set ${MULTI_TENANT_ENV}=1 to accept ` +
          `that exposure deliberately until the tenant rung lands in the principal grammar (OPE-309 phase 1).`,
      );
    }
  }
  if (bad.length > 0) {
    throw new Error("open-everywhere: multi-tenant principal exposure:\n" + bad.join("\n") + "\n(access/tenant-admission.ts / identity/principal-key.ts)");
  }
}

export function tenantRungRemedy(entry: string, domains?: readonly Domain[]): string {
  const slash = entry.indexOf("/");
  const platform = slash > 0 ? entry.slice(0, slash) : "";
  if (!isTenantScopedPlatform(platform)) return "";
  const tenant = domains ? soleAdmittedTenant(platform, domains) : soleAdmittedTenantFromConfig(platform);
  return ` ${principalKeyReplacementHint(entry, tenant)}`;
}

export type TenantAdmissionDecision = "proceed" | "unadmitted";

export interface TenantAdmissionInput {
  readonly platform: string;
  readonly tenant: string | undefined | null;
  readonly admitted: ReadonlySet<string>;
}

export function classifyTenantAdmission(input: TenantAdmissionInput): TenantAdmissionDecision {
  if (!isTenantScopedPlatform(input.platform)) return "proceed";
  if (multiTenantPrincipalsAllowed()) return "proceed";
  if (input.admitted.size === 0) return "proceed";
  const tenant = typeof input.tenant === "string" ? input.tenant.trim() : "";
  if (tenant.length === 0) return "proceed";
  return input.admitted.has(tenant) ? "proceed" : "unadmitted";
}

export const UNADMITTED_TENANT_DROP_REASON = "tenant is not admitted on this deployment — principal keys would alias";

export function unadmittedTenantLog(platform: string, tenant: string, admitted: ReadonlySet<string>): string {
  return (
    `[open-everywhere:${platform}] wake dropped — tenant "${tenant}" is not admitted on this deployment ` +
    `(declared: ${[...admitted].sort().join(", ") || "none"}). A ${platform} person id is issued per tenant, so admitting a second one ` +
    `would let two people share one principal key. Add a channel for that tenant to agent/memory/config/domains.ts, or set ${MULTI_TENANT_ENV}=1 ` +
    "to accept multi-tenant principals deliberately (OPE-309)."
  );
}
