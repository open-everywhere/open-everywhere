import { resolvePartition } from "../memory/partition.js";
import { bindFrom, type BindableContext, type Visibility, type Trust } from "../identity/binding.js";
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

export function buildResolveRequest(ctx: BindableContext): ResolveRequest {
  const b = bindFrom(ctx);
  const p = resolvePartition(ctx);
  return {
    mode: b.mode,
    platform: p.platform,
    workspace: p.workspace,
    channel: p.surface,
    domains: getConfig().domainsForSurface({ workspaceKey: p.workspaceKey, surface: p.surface }),
    principalId: b.principalId,
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
