export const PRINCIPAL_KEY = /^[a-z0-9][a-z0-9-]*\/[^/\s]+$/u;

export const TENANT_PRINCIPAL_KEY = /^[a-z0-9][a-z0-9-]*\/[^/\s]+\/[^/\s]+$/u;

export const UNNAMED_TENANT = "dev";

export function principalKey(platform: string, tenant: string | undefined | null, id: string): string {
  const key = tryPrincipalKey(platform, tenant, id);
  if (key === undefined) throw new Error(principalTenantUnresolvableMessage(platform, id));
  return key;
}

export function tryPrincipalKey(platform: string, tenant: string | undefined | null, id: string): string | undefined {
  if (!isTenantScopedPlatform(platform)) return `${platform}/${id}`;
  const named = typeof tenant === "string" ? tenant.trim() : "";
  if (named.length === 0 || named === UNNAMED_TENANT || named.includes("/")) return undefined;
  return `${platform}/${named}/${id}`;
}

export function principalTenantUnresolvableMessage(platform: string, id?: string): string {
  return (
    `cannot name the ${platform} tenant for ${id ? `"${id}"` : "this person"}: on ${platform} a person id is issued PER ` +
    `WORKSPACE, so a principal key has to carry which workspace it came from ("${platform}/<tenant-id>/<native-id>"), and this ` +
    `call named none — the delivery carried no workspace, or it fell back to "${UNNAMED_TENANT}", which is the string for ` +
    "\"nobody said\" and not a workspace id. Fail closed: no standing is granted rather than guessing a tenant. " +
    "(identity/principal-key.ts, OPE-309)"
  );
}

export function isQualifiedPrincipalKey(value: string | undefined): boolean {
  if (value === undefined) return false;
  const slash = value.indexOf("/");
  if (slash <= 0) return false;
  const platform = value.slice(0, slash);
  if (!isTenantScopedPlatform(platform)) return PRINCIPAL_KEY.test(value);
  return TENANT_PRINCIPAL_KEY.test(value) && value.split("/")[1] !== UNNAMED_TENANT;
}

export function parsePrincipalKey(
  value: string | undefined,
): { readonly platform: string; readonly tenant?: string; readonly id: string } | undefined {
  if (!isQualifiedPrincipalKey(value)) return undefined;
  const parts = value!.split("/");
  return parts.length === 3
    ? { platform: parts[0]!, tenant: parts[1]!, id: parts[2]! }
    : { platform: parts[0]!, id: parts[1]! };
}

export function rosterHasPrincipal(
  roster: readonly string[] | undefined,
  platform: string | undefined,
  tenant: string | undefined | null,
  id: string | undefined,
): boolean {
  if (!roster || roster.length === 0 || !platform || !id) return false;
  const key = tryPrincipalKey(platform, tenant, id);
  return key !== undefined && roster.includes(key);
}

export function principalKeyReplacementHint(entry: string, tenant: string | undefined): string {
  const slash = entry.indexOf("/");
  const platform = slash > 0 ? entry.slice(0, slash) : entry;
  const id = slash > 0 ? entry.slice(slash + 1) : entry;
  return tenant
    ? `On ${platform} a person id is issued PER WORKSPACE, so the key needs the workspace rung. This deployment declares exactly one ${platform} workspace, so the replacement is "${platform}/${tenant}/${id}".`
    : `On ${platform} a person id is issued PER WORKSPACE, so the key needs the workspace rung: "${platform}/<tenant-id>/${id}". The tenant id is the SECOND segment of this deployment's ${platform} channel keys in agent/memory/domains.ts (a channel "${platform}/T0AB1CD2E/C123" makes the key "${platform}/T0AB1CD2E/${id}").`;
}

const TENANT_SCOPED_PLATFORMS: ReadonlySet<string> = new Set(["slack"]);

export function isTenantScopedPlatform(platform: string | undefined): boolean {
  return platform !== undefined && TENANT_SCOPED_PLATFORMS.has(platform);
}

export function principalIdsOnPlatform(
  roster: Iterable<string>,
  platform: string | undefined,
  tenant: string | undefined | null,
): string[] {
  if (!platform) return [];
  const scoped = isTenantScopedPlatform(platform);
  const named = typeof tenant === "string" ? tenant.trim() : "";
  if (scoped && (named.length === 0 || named === UNNAMED_TENANT)) return [];
  const ids: string[] = [];
  for (const entry of roster) {
    const parsed = parsePrincipalKey(entry);
    if (parsed?.platform !== platform) continue;
    if (scoped && parsed.tenant !== named) continue;
    ids.push(parsed.id);
  }
  return ids;
}
