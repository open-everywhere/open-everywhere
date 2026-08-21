import { hasWorkGrant } from "./work-grant.js";
import { resolveWindowSources, type BindableContext } from "../identity/binding.js";
import { resolveDomainForChannel, type Domain } from "../memory/domain.js";
import { resolvePartition } from "../memory/partition.js";

export const SURFACE_WORK_ROLES: Readonly<Record<string, string>> = {
  slack: "work-token",
  discord: "work-token",
  teams: "work-token",
};

export function surfaceWorkRole(platform: string): string | undefined {
  return SURFACE_WORK_ROLES[platform];
}

export function domainHoldsSurfaceWorkGrant(domain: Domain | undefined, platform: string): boolean {
  const role = surfaceWorkRole(platform);
  if (!role) return false;
  return hasWorkGrant(domain, platform, role);
}

function callerDomain(ctx: BindableContext, domains: readonly Domain[]): Domain | undefined {
  try {
    return resolveDomainForChannel(resolvePartition(ctx).surfaceKey, domains).domain;
  } catch {
    return undefined;
  }
}

export function surfaceWorkReadPlatforms(ctx: BindableContext, domains: readonly Domain[]): readonly string[] {
  const domain = callerDomain(ctx, domains);
  if (!domain) return [];
  let sources: readonly string[];
  try {
    sources = resolveWindowSources(ctx, domains);
  } catch {
    return [];
  }
  return sources.filter((platform) => domainHoldsSurfaceWorkGrant(domain, platform));
}

export function surfaceWorkReadMount(ctx: BindableContext, domains: () => readonly Domain[]): boolean {
  try {
    return surfaceWorkReadPlatforms(ctx, domains()).length > 0;
  } catch {
    return false;
  }
}

export class SurfaceWorkGrantError extends Error {
  constructor(readonly platform: string, message: string) {
    super(message);
  }
}

export function assertSurfaceWorkGrant(ctx: BindableContext, domains: readonly Domain[], platform: string): void {
  if (domainHoldsSurfaceWorkGrant(callerDomain(ctx, domains), platform)) return;
  throw new SurfaceWorkGrantError(
    platform,
    `work read: this domain holds no ${platform} work grant — declare the ${platform} work role ` +
      `("${surfaceWorkRole(platform) ?? "<none>"}") in its \`credentials\` to read ${platform} on the work plane.`,
  );
}
