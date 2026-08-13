import { appendAudit, deploymentOrg } from "@open-everywhere/core/agent/adapter-api.js";

export type TeamsReadBoundary = "per-team" | "tenant-wide" | "unknown";

export const TENANT_WIDE_CHANNEL_READ_ROLES: readonly string[] = ["ChannelMessage.Read.All", "Group.Read.All", "Group.ReadWrite.All"];

export const TEAMS_READ_BOUNDARY_SOURCES: readonly string[] = [
  "https://learn.microsoft.com/en-us/graph/api/channel-list-messages",
  "https://learn.microsoft.com/en-us/graph/api/chatmessage-list-replies",
  "https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/resource-specific-consent",
];

export const TEAMS_READ_BOUNDARY_ACTION = "teams.read_boundary";

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

let held: TeamsReadBoundary = "unknown";
let heldRoles: readonly string[] = [];

export function teamsReadBoundary(): TeamsReadBoundary {
  return held;
}

export function _resetTeamsReadBoundaryForTest(): void {
  held = "unknown";
  heldRoles = [];
}

export async function noteTeamsReadBoundary(token: string): Promise<TeamsReadBoundary> {
  const roles = decodeJwtRoles(token);
  const boundary = boundaryFromRoles(roles);
  const tenantWide = tenantWideRolesIn(roles ?? []);
  const changed = boundary !== held || tenantWide.join(",") !== heldRoles.join(",");
  held = boundary;
  heldRoles = tenantWide;
  if (!changed) return boundary;
  try {
    await appendAudit({
      org: deploymentOrg(),
      platform: "teams",
      workspace: "unknown",
      action: TEAMS_READ_BOUNDARY_ACTION,
      detail: {
        boundary,
        tenantWideRoles: [...tenantWide],
        enforcedBy: boundary === "tenant-wide" ? "open-everywhere-domain-allowlist" : "microsoft-rsc-per-team",
      },
    });
  } catch (err) {
    console.warn(`[open-everywhere:audit] teams read-boundary row was not written: ${String(err)}`);
  }
  return boundary;
}
