export const PRINCIPAL_KEY = /^[a-z0-9][a-z0-9-]*\/[^/\s]+$/u;

export function principalKey(platform: string, id: string): string {
  return `${platform}/${id}`;
}

export function isQualifiedPrincipalKey(value: string | undefined): boolean {
  return value !== undefined && PRINCIPAL_KEY.test(value);
}

export function parsePrincipalKey(value: string | undefined): { readonly platform: string; readonly id: string } | undefined {
  if (!isQualifiedPrincipalKey(value)) return undefined;
  const slash = value!.indexOf("/");
  return { platform: value!.slice(0, slash), id: value!.slice(slash + 1) };
}

export function rosterHasPrincipal(
  roster: readonly string[] | undefined,
  platform: string | undefined,
  id: string | undefined,
): boolean {
  if (!roster || roster.length === 0 || !platform || !id) return false;
  return roster.includes(principalKey(platform, id));
}

export function principalIdsOnPlatform(roster: Iterable<string>, platform: string | undefined): string[] {
  if (!platform) return [];
  const ids: string[] = [];
  for (const entry of roster) {
    const parsed = parsePrincipalKey(entry);
    if (parsed?.platform === platform) ids.push(parsed.id);
  }
  return ids;
}
