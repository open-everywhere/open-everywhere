import { adminControlRoles } from "../access/roles.js";
import { getConfig } from "../access/config.js";
import { domainForChannel } from "../memory/domain.js";
import { nativeAdminCheck } from "../access/native-admin.js";
import { platformOfScopeKey } from "../access/scope-key.js";
import { appendAudit, readAudit } from "../audit/audit.js";
import { whereFromScope } from "../approvals/actions.js";

export type CapBypassStanding = "roster" | "guild-admin";

export interface CapBypass {
  readonly standing: CapBypassStanding;
  readonly warn: boolean;
}

const WARN_COOLDOWN_MS = 60 * 60 * 1000;

export function rosterStanding(roles: readonly string[], coveringDomain: string | null): boolean {
  return roles.includes("admin") || (coveringDomain !== null && roles.includes(`domain:${coveringDomain}`));
}

export async function capBypassFor(input: {
  readonly org: string;
  readonly principalId: string | undefined;
  readonly surfaceKey: string;
  readonly reason?: string;
}): Promise<CapBypass | null> {
  try {
    if (!input.principalId) return null;
    const domains = getConfig().loadDomains();
    let standing: CapBypassStanding | null = null;
    const platform = platformOfScopeKey(input.surfaceKey);
    const roles = adminControlRoles(input.principalId, domains, platform);
    if (rosterStanding(roles, domainForChannel(input.surfaceKey, domains)?.name ?? null)) {
      standing = "roster";
    } else {
      const check = platform ? nativeAdminCheck(platform) : undefined;
      if (check && (await check(input.surfaceKey, input.principalId))) standing = "guild-admin";
    }
    if (!standing) return null;

    const where = whereFromScope(input.org, input.surfaceKey);
    let warn = true;
    try {
      const recent = await readAudit({
        ...where,
        action: "spend.cap_bypassed",
        since: new Date(Date.now() - WARN_COOLDOWN_MS).toISOString(),
        limit: 1,
      });
      warn = recent.length === 0;
    } catch {
      warn = true;
    }
    try {
      await appendAudit({
        ...where,
        principalId: input.principalId,
        action: "spend.cap_bypassed",
        detail: { standing, ...(input.reason ? { reason: input.reason } : {}) },
      });
    } catch {
    }
    return { standing, warn };
  } catch {
    return null;
  }
}
