import { actingPrincipalId, bindFrom, type BindableContext, type SurfaceBinding } from "../identity/binding.js";
import { adminStandingSubject } from "./admin-standing.js";
import { rosterHasPrincipal, tryPrincipalKey } from "../identity/principal-key.js";
import { domainForChannel, criteriaDomain, type Domain } from "../memory/domain.js";
import { getConfig } from "./config.js";

export interface Role {
  readonly principalId?: string;
  readonly isOrgAdmin: boolean;
  readonly isDomainAdmin: boolean;
  readonly domain?: string;
  readonly unverified?: string;
}

const NO_ROLE: Role = { isOrgAdmin: false, isDomainAdmin: false };

export function roleForBinding(binding: SurfaceBinding, domains: readonly Domain[]): Role {
  const principalId = actingPrincipalId(binding);
  if (!principalId) return NO_ROLE;

  const rosterAdmits = (roster: readonly string[] | undefined): boolean =>
    rosterHasPrincipal(roster, binding.platform, binding.workspace, principalId, binding.enterprise);

  const org = criteriaDomain("org", domains);
  const isOrgAdmin = rosterAdmits(org?.admins);

  const channelKey = `${binding.platform}/${binding.workspace}/${binding.domainSurface ?? binding.surface}`;
  const explicit = domainForChannel(channelKey, domains);
  const isDomainAdmin = isOrgAdmin || rosterAdmits(explicit?.admins);

  return { principalId, isOrgAdmin, isDomainAdmin, domain: explicit?.name };
}

export function resolveRole(ctx: BindableContext): Role {
  const binding = bindFrom(ctx);
  const domains = getConfig().loadDomains();
  const subject = adminStandingSubject(binding, ctx);
  if (!subject.ok) return { ...NO_ROLE, unverified: subject.message };
  return roleForBinding({ ...binding, principalId: subject.principalId }, domains);
}

export function requireOrgAdmin(ctx: BindableContext): Role {
  const role = resolveRole(ctx);
  if (role.unverified !== undefined) throw new Error(role.unverified);
  if (!role.isOrgAdmin) {
    throw new Error(
      `this action requires an org admin.${
        role.principalId ? ` Your id ("${role.principalId}") isn't listed.` : " No verified sender id on this turn."
      } Add the QUALIFIED principal key ("<platform>/<id>", or "<platform>/<tenant-id>/<id>" on Slack, where the tenant may be the Enterprise Grid id) to the "org" pseudo-domain's admins (Domain.admins, agent/memory/config/domains.ts) to grant org-admin.`,
    );
  }
  return role;
}

export function requireDomainAdminOrOrg(ctx: BindableContext): Role {
  const role = resolveRole(ctx);
  if (role.unverified !== undefined) throw new Error(role.unverified);
  if (!role.isDomainAdmin) {
    const hint = role.principalId ? `Your id ("${role.principalId}") isn't listed.` : "No verified sender id on this turn.";
    const fix = role.domain
      ? `Add the QUALIFIED principal key ("<platform>/<id>", or "<platform>/<tenant-id>/<id>" on Slack, where the tenant may be the Enterprise Grid id) to domain "${role.domain}"'s admins (Domain.admins, agent/memory/config/domains.ts).`
      : `This channel isn't in an explicit domain, so only an org admin can do this — add the QUALIFIED principal key ("<platform>/<id>", or "<platform>/<tenant-id>/<id>" on Slack, where the tenant may be the Enterprise Grid id) to the "org" pseudo-domain's admins.`;
    throw new Error(`this action requires a domain admin (or an org admin). ${hint} ${fix}`);
  }
  return role;
}

export function adminControlRoles(
  principalId: string | undefined,
  domains: readonly Domain[],
  platform: string | undefined,
  tenant: string | undefined,
  enterprise?: string,
): string[] {
  if (!principalId || !platform) return [];
  const key = tryPrincipalKey(platform, tenant, principalId);
  if (key === undefined) return [];
  const admits = (roster: readonly string[] | undefined): boolean =>
    rosterHasPrincipal(roster, platform, tenant, principalId, enterprise);
  if (admits(criteriaDomain("org", domains)?.admins)) return ["admin"];
  return domains.filter((d) => d.match === undefined && admits(d.admins)).map((d) => `domain:${d.name}`);
}
