import { containerWorkRoleFor, hasWorkGrant, hasGithubWorkGrant, GITHUB_CONNECTOR, WORK_ROLES } from "./work-grant.js";
import { resolveAccessFor } from "./request.js";
import { isSubagentChildContext, resolveWindowSources, type BindableContext } from "../identity/binding.js";
import { delegatedBindingThisTurn } from "../identity/delegated-binding.js";
import { resolveDomainForChannel, type Domain } from "../memory/domain.js";
import { resolvePartition } from "../memory/partition.js";

export function surfaceWorkRole(platform: string): string | undefined {
  return containerWorkRoleFor(platform);
}

export const SURFACE_WORK_ROLES: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(WORK_ROLES.filter((w) => w.kind === "container").map((w) => [w.connector, w.role])),
);

export function domainHoldsSurfaceWorkGrant(
  domain: Domain | undefined,
  platform: string,
  repos: readonly string[] = [],
): boolean {
  if (platform === GITHUB_CONNECTOR) return hasGithubWorkGrant(repos);
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

function callerRepos(ctx: BindableContext): readonly string[] {
  try {
    return resolveAccessFor(ctx).repos;
  } catch {
    return [];
  }
}

export function surfaceWorkReadPlatforms(ctx: BindableContext, domains: readonly Domain[]): readonly string[] {
  const domain = callerDomain(ctx, domains);
  let sources: readonly string[];
  try {
    sources = resolveWindowSources(ctx, domains);
  } catch {
    return [];
  }
  const repos = callerRepos(ctx);
  return sources.filter((platform) => domainHoldsSurfaceWorkGrant(domain, platform, repos));
}

function originBoundReadPlatform(platform: string): boolean {
  return platform === GITHUB_CONNECTOR || containerWorkRoleFor(platform) !== undefined;
}

export function workerOriginReadPlatform(ctx: BindableContext, domains: readonly Domain[]): string | undefined {
  try {
    if (!isSubagentChildContext(ctx)) return undefined;
    const origin = delegatedBindingThisTurn(undefined)?.platform;
    if (origin === undefined || !originBoundReadPlatform(origin)) return undefined;
    return resolveWindowSources(ctx, domains).includes(origin) ? origin : undefined;
  } catch {
    return undefined;
  }
}

export function surfaceWorkReadMount(ctx: BindableContext, domains: () => readonly Domain[]): boolean {
  try {
    if (isSubagentChildContext(ctx)) return workerOriginReadPlatform(ctx, domains()) !== undefined;
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
  if (workerOriginReadPlatform(ctx, domains) === platform) return;
  if (domainHoldsSurfaceWorkGrant(callerDomain(ctx, domains), platform, callerRepos(ctx))) return;
  const remedy =
    platform === GITHUB_CONNECTOR
      ? "grant this scope at least one repo in its access bundle's `repos:` to read github on the work plane."
      : `declare the ${platform} work role ("${surfaceWorkRole(platform) ?? "<none>"}") in its ` +
        `\`credentials\` to read ${platform} on the work plane.`;
  throw new SurfaceWorkGrantError(platform, `work read: this domain holds no ${platform} work grant — ${remedy}`);
}
