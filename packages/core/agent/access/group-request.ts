import { resolvePartition } from "../memory/partition.js";
import { actingPrincipalId, bindFrom, type BindableContext } from "../identity/binding.js";
import { groupsForPrincipal, type Group } from "../identity/groups.js";
import { principalKey } from "../identity/principal-key.js";
import { resolveLinkSet } from "../identity/link-store.js";
import { hasRatifiedShare, sharedVaultSubject } from "../identity/oauth-vault-share.js";
import { getConfig } from "./config.js";
import { buildResolveRequest } from "./request.js";
import { resolveAccess, type EffectiveAccess, type ResolveRequest } from "./resolver.js";

export async function callerLinkSets(org: string, platform: string, nativeId: string): Promise<readonly string[]> {
  try {
    const set = await resolveLinkSet(org, platform, nativeId);
    return set ? [set.id] : [];
  } catch {
    return [];
  }
}

export async function sharedVaultSubjectFor(
  org: string,
  connector: string,
  platform: string,
  nativeId: string,
): Promise<string | undefined> {
  try {
    const sets = await callerLinkSets(org, platform, nativeId);
    const linkSetId = sets[0];
    if (linkSetId === undefined) return undefined;
    if (!(await hasRatifiedShare(org, linkSetId, connector, platform, nativeId))) return undefined;
    return sharedVaultSubject(org, linkSetId);
  } catch {
    return undefined;
  }
}

export async function callerLinkSetsForCtx(ctx: BindableContext): Promise<readonly string[]> {
  const acting = actingPrincipalId(bindFrom(ctx));
  if (acting === undefined) return [];
  return callerLinkSets(resolvePartition(ctx).org, bindFrom(ctx).platform, acting);
}

export async function withLinkSetGroups(
  req: ResolveRequest,
  org: string,
  groups: readonly Group[] = getConfig().loadGroups?.() ?? [],
): Promise<ResolveRequest> {
  if (req.mode !== "dm" || req.principalId === undefined) return req;
  const sets = await callerLinkSets(org, req.platform, req.principalId);
  if (sets.length === 0) return req;
  let out: ResolveRequest = { ...req, principalLinkSets: [...new Set([...(req.principalLinkSets ?? []), ...sets])].sort() };
  if (groups.length > 0) {
    const viaSets = groupsForPrincipal(groups, principalKey(req.platform, req.principalId), sets);
    if (viaSets.length > 0) out = { ...out, groups: [...new Set([...(req.groups ?? []), ...viaSets])].sort() };
  }
  return out;
}

export async function buildResolveRequestWithGroups(ctx: BindableContext): Promise<ResolveRequest> {
  return withLinkSetGroups(buildResolveRequest(ctx), resolvePartition(ctx).org);
}

export async function resolveAccessForWithGroups(ctx: BindableContext): Promise<EffectiveAccess> {
  const cfg = getConfig();
  const acting = actingPrincipalId(bindFrom(ctx));
  const req = acting === undefined ? buildResolveRequest(ctx) : await buildResolveRequestWithGroups(ctx);
  return resolveAccess(req, cfg.loadBundles(), cfg.loadBindings(), cfg.pluginRegistry, cfg.loadProviders?.() ?? []);
}
