import { resolvePartition } from "../memory/partition.js";
import { actingPrincipalId, bindFrom, type BindableContext, type Visibility, type Trust } from "../identity/binding.js";
import { resolveAccess, type EffectiveAccess, type ResolveRequest, type SessionMode } from "./resolver.js";
import { getConfig } from "./config.js";

export type { Visibility, Trust } from "../identity/binding.js";

export function resolveMode(ctx: BindableContext): SessionMode {
  return bindFrom(ctx).mode;
}

export function resolveTrust(ctx: BindableContext): Trust {
  return bindFrom(ctx).trust;
}

export function resolveVisibility(ctx: BindableContext): Visibility {
  return bindFrom(ctx).visibility;
}

export function principalIdOf(ctx: BindableContext): string | undefined {
  return bindFrom(ctx).principalId;
}

export function actingPrincipalIdOf(ctx: BindableContext): string | undefined {
  return actingPrincipalId(bindFrom(ctx));
}

export function buildResolveRequest(ctx: BindableContext): ResolveRequest {
  const b = bindFrom(ctx);
  const p = resolvePartition(ctx);
  return {
    mode: b.mode,
    platform: p.platform,
    workspace: p.workspace,
    channel: b.domainSurface ?? p.surface,
    domains: getConfig().domainsForSurface({ workspaceKey: p.workspaceKey, surface: b.domainSurface ?? p.surface }),
    principalId: actingPrincipalId(b),
  };
}

export function resolveAccessFor(ctx: BindableContext): EffectiveAccess {
  const cfg = getConfig();
  return resolveAccess(
    buildResolveRequest(ctx),
    cfg.loadBundles(),
    cfg.loadBindings(),
    cfg.pluginRegistry,
    cfg.loadProviders?.() ?? [],
  );
}
