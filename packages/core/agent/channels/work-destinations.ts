import type { BindableContext } from "../identity/binding.js";
import { callerWorkDomain, hasGithubWorkGrant, hasWorkGrant, workRoleFor, GITHUB_CONNECTOR } from "../access/work-grant.js";
import { registeredWorkPlatforms, registeredWorkRole } from "./work-registry.js";
import { resolveAccessFor } from "../access/request.js";
import type { Domain } from "../memory/domain.js";

function grantedWorkPlatforms(ctx: BindableContext, domains: readonly Domain[]): readonly string[] {
  const domain = callerWorkDomain(ctx, () => domains);
  if (!domain) return [];
  return registeredWorkPlatforms().filter((platform) => {
    const role = registeredWorkRole(platform) ?? workRoleFor(platform);
    return role !== undefined && hasWorkGrant(domain, platform, role);
  });
}

function grantedRepos(ctx: BindableContext): readonly string[] {
  try {
    return resolveAccessFor(ctx).repos;
  } catch {
    return [];
  }
}

export function workDestinationPlatforms(ctx: BindableContext, domains: readonly Domain[]): readonly string[] {
  const granted = [...grantedWorkPlatforms(ctx, domains)];
  if (hasGithubWorkGrant(grantedRepos(ctx)) && registeredWorkPlatforms().includes(GITHUB_CONNECTOR) && !granted.includes(GITHUB_CONNECTOR)) {
    granted.push(GITHUB_CONNECTOR);
  }
  return granted.sort();
}
