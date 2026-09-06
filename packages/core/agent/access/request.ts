import { resolvePartition } from "../memory/partition.js";
import { actingPrincipalId, bindFrom, unattendedFrom, type BindableContext } from "../identity/binding.js";
import { resolveAccess, type EffectiveAccess, type ResolveRequest, type SessionMode } from "./resolver.js";
import { getConfig } from "./config.js";
import { groupsForPrincipal } from "../identity/groups.js";
import { tryPrincipalKey } from "../identity/principal-key.js";
import { memberPlaneGrants } from "./member-grant.js";

export function resolveMode(ctx: BindableContext): SessionMode {
  return bindFrom(ctx).mode;
}

export function principalIdOf(ctx: BindableContext): string | undefined {
  return bindFrom(ctx).principalId;
}

export function actingPrincipalIdOf(ctx: BindableContext): string | undefined {
  return actingPrincipalId(bindFrom(ctx));
}

export function unattendedOf(ctx: BindableContext): boolean {
  return unattendedFrom(bindFrom(ctx));
}

export function buildResolveRequest(ctx: BindableContext): ResolveRequest {
  const b = bindFrom(ctx);
  const p = resolvePartition(ctx);
  const memberPlane = memberPlaneFor(b.domainSurface ?? p.surface, p.workspaceKey);
  const acting = actingPrincipalId(b);
  return {
    mode: b.mode,
    platform: p.platform,
    workspace: p.workspace,
    channel: b.domainSurface ?? p.surface,
    domains: getConfig().domainsForSurface({ workspaceKey: p.workspaceKey, surface: b.domainSurface ?? p.surface }),
    principalId: acting,
    groups: groupsForPrincipal(getConfig().loadGroups?.() ?? [], acting === undefined ? undefined : tryPrincipalKey(p.platform, p.workspace, acting)),
    ...(memberPlane.length === 0 ? {} : { memberPlane }),
  };
}

function memberPlaneFor(surface: string, workspaceKey: string): readonly string[] {
  try {
    const names = new Set(getConfig().domainsForSurface({ workspaceKey, surface }));
    return memberPlaneGrants(getConfig().loadDomains().filter((d) => names.has(d.name)));
  } catch {
    return [];
  }
}

export function resolveAccessFor(ctx: BindableContext): EffectiveAccess {
  const cfg = getConfig();
  return resolveAccess(
    buildResolveRequest(ctx),
    cfg.loadBundles(),
    cfg.loadBindings(),
    cfg.pluginRegistry,
    cfg.loadConnectorCredentials?.() ?? [],
  );
}
