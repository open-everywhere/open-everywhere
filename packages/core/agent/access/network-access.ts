import type { EffectiveAccess } from "./resolver.js";
import { PACKAGE_REGISTRY_HOSTS, TENANT_KEY, SURFACE_KEY, type Scope, type ScopeLevel } from "./bundle.js";

export type NetworkAccessLevel = "trusted" | "none" | "full";

const KNOWN_LEVELS: ReadonlySet<string> = new Set<NetworkAccessLevel>(["trusted", "none", "full"]);

export const TRUSTED_ACCESS_DEVELOPER_HOSTS: readonly string[] = ["github.com"];

export const TRUSTED_ACCESS_HOSTS: readonly string[] = [...PACKAGE_REGISTRY_HOSTS, ...TRUSTED_ACCESS_DEVELOPER_HOSTS];

export const DEFAULT_NETWORK_ACCESS_LEVEL: NetworkAccessLevel = "none";

const CONTAINER_LEVELS: ReadonlySet<ScopeLevel> = new Set<ScopeLevel>(["org", "tenant", "domain", "surface"]);

const SPECIFICITY: Readonly<Record<string, number>> = { org: 0, tenant: 1, domain: 2, surface: 3 };

export interface NetworkAccessBinding {
  readonly scope: Scope;
  readonly level: NetworkAccessLevel;
}

export function defineNetworkAccess(binding: NetworkAccessBinding): NetworkAccessBinding {
  return binding;
}

const LEVEL_FIELD: Readonly<Record<string, "tenant" | "domain" | "surface" | undefined>> = {
  org: undefined,
  tenant: "tenant",
  domain: "domain",
  surface: "surface",
};

export interface NetworkAccessValidationDeps {
  readonly warn?: (message: string) => void;
}

export function assertNetworkAccessValid(bindings: readonly NetworkAccessBinding[], deps: NetworkAccessValidationDeps = {}): void {
  const bad: string[] = [];
  const seen = new Set<string>();
  for (const b of bindings) {
    const where = `networkAccess binding (${b.scope.level} scope)`;
    if (!KNOWN_LEVELS.has(b.level)) {
      bad.push(`  ${where} has unknown level ${JSON.stringify(b.level)} — known levels: "trusted" | "none" | "full"`);
    }
    if (!CONTAINER_LEVELS.has(b.scope.level)) {
      bad.push(
        `  ${where} — network access is pinned on the CONTAINER LADDER only (org | tenant | domain | surface); ` +
          `"group"/"principal" scopes are the DM personal universe and never pin a compute environment ` +
          `(Tag's own Environment object is org-scoped, never per-account — see network-access.ts's header)`,
      );
      continue;
    }
    const required = LEVEL_FIELD[b.scope.level];
    const { tenant, domain, surface } = b.scope;
    for (const [field, value] of [["tenant", tenant], ["domain", domain], ["surface", surface]] as const) {
      if (field === required) {
        if (!value) bad.push(`  ${where} needs scope.${field} — a ${b.scope.level}-level binding can never match without one`);
      } else if (value !== undefined) {
        bad.push(`  ${where} also sets scope.${field} — a ${b.scope.level}-level scope carries only scope.${required ?? "(nothing)"}; drop it or change the level`);
      }
    }
    if (tenant && !TENANT_KEY.test(tenant)) {
      bad.push(`  ${where} scope.tenant "${tenant}" must be the PLATFORM-QUALIFIED tenant key "platform/<tenant-id>" (e.g. "slack/T0123ABC")`);
    }
    if (surface && !SURFACE_KEY.test(surface)) {
      bad.push(`  ${where} scope.surface "${surface}" must be the fully-qualified surface key "platform/<tenant-id>/<container-id>" (e.g. "slack/T0123ABC/C0123ABC")`);
    }
    if (domain?.includes("/")) {
      bad.push(`  ${where} scope.domain "${domain}" contains "/" — a domain scope takes the BARE domain name, deliberately not tenant-qualified`);
    }
    const key = `${b.scope.level}:${tenant ?? domain ?? surface ?? ""}`;
    if (seen.has(key)) {
      bad.push(`  two networkAccess bindings pin the SAME scope (${b.scope.level}${tenant ?? domain ?? surface ? ` "${tenant ?? domain ?? surface}"` : ""}) — resolution order would be undefined; merge them into one binding`);
    }
    seen.add(key);
  }
  if (bad.length > 0) {
    throw new Error("open-everywhere: invalid networkAccess binding(s):\n" + bad.join("\n") + "\n(access/network-access.ts / docs/how-it-works/access-and-scoping.md)");
  }
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  for (const b of bindings) {
    if (b.level !== "full") continue;
    if (b.scope.level !== "org" && b.scope.level !== "tenant") continue;
    const where = b.scope.level === "org" ? "org scope" : `tenant scope ("${b.scope.tenant}")`;
    warn(
      `[open-everywhere:network-access] broad grant: a "full" networkAccess pin sits at ${where} — every surface under it ` +
        `(including future ones) gets unrestricted, credential-less egress. Narrow it to a domain or surface scope if possible.`,
    );
  }
}

function scopeMatchesContainer(scope: Scope, access: Pick<EffectiveAccess, "mode" | "tenantKey" | "surfaceKey" | "domains">): boolean {
  switch (scope.level) {
    case "org":
      return true;
    case "tenant":
      return access.mode !== "dm" && scope.tenant === access.tenantKey;
    case "domain":
      return access.mode !== "dm" && (scope.domain !== undefined && access.domains.includes(scope.domain));
    case "surface":
      return access.mode !== "dm" && scope.surface === access.surfaceKey;
    default:
      return false;
  }
}

export function resolveNetworkAccessLevel(
  access: Pick<EffectiveAccess, "mode" | "tenantKey" | "surfaceKey" | "domains">,
  bindings: readonly NetworkAccessBinding[],
): NetworkAccessLevel {
  let best: { specificity: number; level: NetworkAccessLevel } | undefined;
  for (const b of bindings) {
    if (!CONTAINER_LEVELS.has(b.scope.level)) continue;
    if (!scopeMatchesContainer(b.scope, access)) continue;
    const specificity = SPECIFICITY[b.scope.level]!;
    if (best === undefined || specificity > best.specificity) best = { specificity, level: b.level };
  }
  return best?.level ?? DEFAULT_NETWORK_ACCESS_LEVEL;
}
