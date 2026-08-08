import { resolvePartition } from "../memory/partition.js";
import { resolveRole, requireOrgAdmin } from "./roles.js";
import { resolveSkillDomainDetailed } from "../skills/domain-skills.js";
import { reportDomainRefusalMessage } from "../spend/reporting.js";
import { bindFrom, currentTurnAddressing, windowGrainOf, type BindableContext } from "../identity/binding.js";

export interface AnalyticsScope {
  readonly org: string;
  readonly grain: "org" | "domain" | "self";
  readonly platform: string;
  readonly domain?: string;
  readonly principalId?: string;
  readonly rowMode: boolean;
  readonly auditDetail: boolean;
  readonly dmUnmasked: boolean;
}

export function resolveAnalyticsScope(ctx: BindableContext, requested: "org" | "domain" | "self"): AnalyticsScope {
  const org = resolvePartition(ctx).org;
  const role = resolveRole(ctx);
  const platform = bindFrom(ctx).platform;

  if (!role.principalId) {
    throw new Error("Analytics needs a verified sender on this turn — none was resolved, so no analytics scope is available.");
  }

  if (requested === "self") {
    return { org, platform, grain: "self", principalId: role.principalId, rowMode: true, auditDetail: false, dmUnmasked: false };
  }

  if (requested === "org") {
    requireOrgAdmin(ctx);
    const inOwnDm = bindFrom(ctx).mode === "dm";
    return { org, platform, grain: "org", rowMode: true, auditDetail: true, dmUnmasked: inOwnDm };
  }

  const resolved = resolveSkillDomainDetailed(ctx);
  if (resolved.domain === null) throw new Error(reportDomainRefusalMessage(resolved.reason));
  return {
    org,
    platform,
    grain: "domain",
    domain: resolved.domain,
    rowMode: role.isDomainAdmin,
    auditDetail: role.isOrgAdmin,
    dmUnmasked: false,
  };
}

export function isAmbientNonAddressedTurn(ctx: BindableContext): boolean {
  let grain: string;
  try {
    grain = windowGrainOf(ctx);
  } catch {
    return false;
  }
  if (grain !== "standing") return false;
  return currentTurnAddressing(ctx) !== "direct-mention";
}
