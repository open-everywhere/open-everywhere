import { getConfig } from "./config.js";
import { isTenantScopedPlatform, principalKeyReplacementHint } from "../identity/principal-key.js";
import type { Domain } from "../memory/domain.js";

export type TenantRung = "workspace" | "enterprise";

export interface TenantRungSets {
  readonly workspaces: ReadonlySet<string>;
  readonly enterprises: ReadonlySet<string>;
}

const ENTERPRISE_RUNG_PREFIX: ReadonlyMap<string, string> = new Map([["slack", "E"]]);

export function tenantRungOf(platform: string, tenant: string): TenantRung {
  const prefix = ENTERPRISE_RUNG_PREFIX.get(platform);
  return prefix !== undefined && tenant.startsWith(prefix) ? "enterprise" : "workspace";
}

export function splitTenantRungs(platform: string, tenants: Iterable<string>): TenantRungSets {
  const workspaces = new Set<string>();
  const enterprises = new Set<string>();
  for (const t of tenants) (tenantRungOf(platform, t) === "enterprise" ? enterprises : workspaces).add(t);
  return { workspaces, enterprises };
}

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
  const { workspaces, enterprises } = splitTenantRungs(platform, admittedTenants(platform, domains));
  if (enterprises.size > 0) return undefined;
  return workspaces.size === 1 ? [...workspaces][0] : undefined;
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
    const rungs = splitTenantRungs(platform, admittedTenants(platform, domains));
    for (const [rung, ids] of [
      ["tenants", rungs.workspaces],
      ["enterprises", rungs.enterprises],
    ] as const) {
      const tenants = [...ids].sort();
      if (tenants.length <= 1) continue;
      const exposure =
        rung === "enterprises"
          ? `Each \`E…\` entry admits EVERY workspace under that organisation, and a person id is issued PER WORKSPACE — so two organisations' ` +
            `members share one \`${platform}/<id>\` principal key, across a population no entry here names.`
          : `On ${platform} a person id is issued PER TENANT, but a principal key is only \`${platform}/<id>\` — so two workspaces' members ` +
            `share one key.`;
      const remedy = rung === "enterprises" ? `Keep one ${platform} Enterprise Grid organisation per deployment` : `Keep one ${platform} tenant per deployment`;
      bad.push(
        `  "${platform}" declares ${tenants.length} ${rung === "enterprises" ? "Enterprise Grid organisations" : "tenants"} ` +
          `(${tenants.map((t) => JSON.stringify(t)).join(", ")}). ` +
          `${exposure} Every matcher over that key (admin rosters, wake trust, approval clickers, a DM's personal credentials) can hand one ` +
          `person another's standing on a chance id collision. ${remedy}, or set ${MULTI_TENANT_ENV}=1 to accept ` +
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
  readonly enterprise?: string | undefined | null;
  readonly admitted: ReadonlySet<string>;
}

function namedId(value: string | undefined | null): string {
  return typeof value === "string" ? value.trim() : "";
}

export function classifyTenantAdmission(input: TenantAdmissionInput): TenantAdmissionDecision {
  if (!isTenantScopedPlatform(input.platform)) return "proceed";
  if (multiTenantPrincipalsAllowed()) return "proceed";
  if (input.admitted.size === 0) return "proceed";
  const tenant = namedId(input.tenant);
  const enterprise = namedId(input.enterprise);
  if (tenant.length === 0 && enterprise.length === 0) return "proceed";
  const rungs = splitTenantRungs(input.platform, input.admitted);
  if (tenant.length > 0 && rungs.workspaces.has(tenant)) return "proceed";
  if (enterprise.length > 0 && rungs.enterprises.has(enterprise)) return "proceed";
  return "unadmitted";
}

export const UNADMITTED_TENANT_DROP_REASON = "tenant is not admitted on this deployment — principal keys would alias";

export function unadmittedTenantLog(
  platform: string,
  tenant: string | undefined | null,
  admitted: ReadonlySet<string>,
  enterprise?: string | undefined | null,
): string {
  const named = [
    ...(namedId(tenant) ? [`workspace "${namedId(tenant)}"`] : []),
    ...(namedId(enterprise) ? [`enterprise "${namedId(enterprise)}"`] : []),
  ];
  return (
    `[open-everywhere:${platform}] wake dropped — ${named.join(" / ") || "a delivery naming no tenant"} is not admitted on this deployment ` +
    `(declared: ${[...admitted].sort().join(", ") || "none"}). A ${platform} person id is issued per tenant, so admitting a second one ` +
    `would let two people share one principal key. Add a channel for that tenant to agent/memory/config/domains.ts, or set ${MULTI_TENANT_ENV}=1 ` +
    "to accept multi-tenant principals deliberately (OPE-309)."
  );
}
