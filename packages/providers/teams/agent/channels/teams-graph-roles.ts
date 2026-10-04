export type TeamsReadBoundary = "per-team" | "tenant-wide" | "unknown";

export const TENANT_WIDE_CHANNEL_READ_ROLES: readonly string[] = ["ChannelMessage.Read.All", "Group.Read.All", "Group.ReadWrite.All"];

export function decodeJwtRoles(token: string): readonly string[] | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[1].length === 0) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
  } catch {
    return undefined;
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const roles = (payload as { roles?: unknown }).roles;
  if (roles === undefined) return [];
  if (!Array.isArray(roles)) return undefined;
  return roles.filter((r): r is string => typeof r === "string");
}

export function tenantWideRolesIn(roles: readonly string[]): readonly string[] {
  return TENANT_WIDE_CHANNEL_READ_ROLES.filter((r) => roles.includes(r));
}

export function boundaryFromRoles(roles: readonly string[] | undefined): TeamsReadBoundary {
  if (roles === undefined) return "unknown";
  return tenantWideRolesIn(roles).length > 0 ? "tenant-wide" : "per-team";
}

export function boundaryOfGraphToken(token: string): TeamsReadBoundary {
  return boundaryFromRoles(decodeJwtRoles(token));
}
