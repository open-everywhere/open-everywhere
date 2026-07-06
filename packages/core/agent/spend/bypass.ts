import { adminControlRoles } from "../access/roles.js";
import { getConfig } from "../access/config.js";
import { domainForChannel } from "../memory/domain.js";
import { guildIdFromScopeKey, isGuildAdminViaRest } from "../approvals/discord-admin.js";
import { appendAudit } from "../audit/audit.js";
import { whereFromScope } from "../approvals/actions.js";

export type CapBypassStanding = "roster" | "guild-admin";

export function rosterStanding(roles: readonly string[], coveringDomain: string | null): boolean {
  return roles.includes("admin") || (coveringDomain !== null && roles.includes(`domain:${coveringDomain}`));
}

export async function capBypassFor(input: {
  readonly org: string;
  readonly principalId: string | undefined;
  readonly surfaceKey: string;
  readonly reason?: string;
}): Promise<CapBypassStanding | null> {
  try {
    if (!input.principalId) return null;
    const domains = getConfig().loadDomains();
    let standing: CapBypassStanding | null = null;
    const roles = adminControlRoles(input.principalId, domains);
    if (rosterStanding(roles, domainForChannel(input.surfaceKey, domains)?.name ?? null)) {
      standing = "roster";
    } else {
      const guildId = guildIdFromScopeKey(input.surfaceKey);
      if (guildId && (await isGuildAdminViaRest(guildId, input.principalId))) standing = "guild-admin";
    }
    if (!standing) return null;
    try {
      await appendAudit({
        ...whereFromScope(input.org, input.surfaceKey),
        principalId: input.principalId,
        action: "spend.cap_bypassed",
        detail: { standing, ...(input.reason ? { reason: input.reason } : {}) },
      });
    } catch {
    }
    return standing;
  } catch {
    return null;
  }
}
