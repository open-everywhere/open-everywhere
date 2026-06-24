import { resolvePartition } from "../memory/partition.js";
import { domainsForSurface } from "../memory/domains.js";
import { bindFrom, type BindableContext, type Visibility } from "../identity/binding.js";
import type { ResolveRequest, SessionMode } from "./resolver.js";

export type { Visibility } from "../identity/binding.js";

export function resolveMode(ctx: BindableContext): SessionMode {
  return bindFrom(ctx).mode;
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
    domains: domainsForSurface({ workspaceKey: p.workspaceKey, surface: p.surface }),
    principalId: b.principalId,
  };
}
