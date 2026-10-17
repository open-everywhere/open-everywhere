import { appendAudit, deploymentOrg } from "@open-everywhere/core/agent/adapter-api.js";
import { boundaryFromRoles, decodeJwtRoles, tenantWideRolesIn, type TeamsReadBoundary } from "./teams-graph-roles.js";

export {
  boundaryFromRoles,
  boundaryOfGraphToken,
  decodeJwtRoles,
  TENANT_WIDE_CHANNEL_READ_ROLES,
  type TeamsReadBoundary,
} from "./teams-graph-roles.js";

const TEAMS_READ_BOUNDARY_SOURCES: readonly string[] = [
  "https://learn.microsoft.com/en-us/graph/api/channel-list-messages",
  "https://learn.microsoft.com/en-us/graph/api/chatmessage-list-replies",
  "https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/resource-specific-consent",
];

const TEAMS_READ_BOUNDARY_ACTION = "teams.read_boundary";

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
