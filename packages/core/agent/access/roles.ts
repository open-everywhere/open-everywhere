import { bindFrom, type BindableContext, type SurfaceBinding } from "../identity/binding.js";
import { domainForChannel, criteriaDomain, type Domain } from "../memory/domain.js";
import { getConfig } from "./config.js";

export interface Role {
  readonly principalId?: string;
  readonly isOrgAdmin: boolean;
  readonly isDomainAdmin: boolean;
  readonly domain?: string;
}

const NO_ROLE: Role = { isOrgAdmin: false, isDomainAdmin: false };

export function roleForBinding(binding: SurfaceBinding, domains: readonly Domain[]): Role {
  const principalId = binding.principalId;
  if (!principalId) return NO_ROLE;

  const org = criteriaDomain("org", domains);
  const isOrgAdmin = org?.admins?.includes(principalId) === true;

  const channelKey = `${binding.platform}/${binding.workspace}/${binding.surface}`;
  const explicit = domainForChannel(channelKey, domains);
  const isDomainAdmin = isOrgAdmin || explicit?.admins?.includes(principalId) === true;

  return { principalId, isOrgAdmin, isDomainAdmin, domain: explicit?.name };
}

export function resolveRole(ctx: BindableContext): Role {
  const binding = bindFrom(ctx);
  const domains = getConfig().loadDomains();
  return roleForBinding(binding, domains);
}

export function requireOrgAdmin(ctx: BindableContext): Role {
  const role = resolveRole(ctx);
  if (!role.isOrgAdmin) {
    throw new Error(
      `this action requires an org admin.${
        role.principalId ? ` Your id ("${role.principalId}") isn't listed.` : " No verified sender id on this turn."
      } Add the principal id to the "org" pseudo-domain's admins (Domain.admins, agent/memory/domains.ts) to grant org-admin.`,
    );
  }
  return role;
}

export function requireDomainAdminOrOrg(ctx: BindableContext): Role {
  const role = resolveRole(ctx);
  if (!role.isDomainAdmin) {
    const hint = role.principalId ? `Your id ("${role.principalId}") isn't listed.` : "No verified sender id on this turn.";
    const fix = role.domain
      ? `Add the principal id to domain "${role.domain}"'s admins (Domain.admins, agent/memory/domains.ts).`
      : `This channel isn't in an explicit domain, so only an org admin can do this — add the principal id to the "org" pseudo-domain's admins.`;
    throw new Error(`this action requires a domain admin (or an org admin). ${hint} ${fix}`);
  }
  return role;
}
