import {
  appendAudit,
  bindFrom,
  domainClaimVerdict,
  resolvePartition,
  ChannelScopeError,
  type BindableContext,
  type Domain,
} from "@open-everywhere/core/agent/adapter-api.js";

export type NotionVia = "roster" | "container" | "none";

export interface NotionPageRouting {
  readonly domain?: Domain;
  readonly via: NotionVia;
}

export type NotionScopeReason =
  | "own-page"
  | "roster"
  | "container"
  | "cross-domain"
  | "target-unassigned"
  | "caller-unassigned";

export interface NotionScopeVerdict {
  readonly allowed: boolean;
  readonly reason: NotionScopeReason;
  readonly callerDomain?: string;
  readonly targetDomain?: string;
}

export function canonicalNotionId(id: string): string {
  return id.trim().toLowerCase().replace(/-/g, "");
}

function splitNotionKey(surfaceKey: string): { workspace?: string; page?: string } {
  const parts = surfaceKey.split("/");
  if (parts.length !== 3 || parts[0] !== "notion") return {};
  return { workspace: parts[1] || undefined, page: parts[2] || undefined };
}

export function notionPageDomain(workspace: string | undefined, pageId: string, domains: readonly Domain[]): NotionPageRouting {
  const wanted = canonicalNotionId(pageId);
  if (wanted.length === 0) return { via: "none" };
  const roster = domains.find((d) =>
    (d.channels ?? []).some((key) => {
      const parts = key.split("/");
      return parts.length === 3 && parts[0] === "notion" && canonicalNotionId(parts[2] ?? "") === wanted;
    }),
  );
  if (roster) return { domain: roster, via: "roster" };
  if (!workspace) return { via: "none" };
  const key = `notion/${workspace}/${wanted}`;
  for (const d of domains) {
    if (domainClaimVerdict(canonicalDomainClaims(d), key)?.kind === "admits") return { domain: d, via: "container" };
  }
  return { via: "none" };
}

export function notionRosterWorkspace(pageId: string, domains: readonly Domain[]): string | undefined {
  const routing = notionPageDomain(undefined, pageId, domains);
  if (routing.via !== "roster" || !routing.domain) return undefined;
  const wanted = canonicalNotionId(pageId);
  for (const key of routing.domain.channels ?? []) {
    const { workspace, page } = splitNotionKey(key);
    if (page !== undefined && canonicalNotionId(page) === wanted) return workspace;
  }
  return undefined;
}

function canonicalDomainClaims(d: Domain): Domain {
  const fix = (entry: string): string => {
    const parts = entry.split("/");
    if (parts.length !== 3 || !parts[2]) return entry;
    const glob = parts[2].endsWith("*");
    const body = glob ? parts[2].slice(0, -1) : parts[2];
    return `${parts[0]}/${parts[1]}/${canonicalNotionId(body)}${glob ? "*" : ""}`;
  };
  if (!d.containers && !d.excludeContainers) return d;
  return {
    ...d,
    ...(d.containers ? { containers: d.containers.map(fix) } : {}),
    ...(d.excludeContainers ? { excludeContainers: d.excludeContainers.map(fix) } : {}),
  };
}

export function notionReadScope(callerSurfaceKey: string, pageId: string, domains: readonly Domain[]): NotionScopeVerdict {
  const { workspace, page: ownPage } = splitNotionKey(callerSurfaceKey);
  const wanted = canonicalNotionId(pageId);
  if (ownPage && wanted.length > 0 && canonicalNotionId(ownPage) === wanted) {
    const own = notionPageDomain(workspace, pageId, domains);
    return { allowed: true, reason: "own-page", ...(own.domain ? { callerDomain: own.domain.name, targetDomain: own.domain.name } : {}) };
  }
  const caller = ownPage ? notionPageDomain(workspace, ownPage, domains) : { via: "none" as const };
  const target = notionPageDomain(workspace, pageId, domains);
  if (!target.domain) {
    return { allowed: false, reason: "target-unassigned", ...(caller.domain ? { callerDomain: caller.domain.name } : {}) };
  }
  if (!caller.domain) {
    return { allowed: false, reason: "caller-unassigned", targetDomain: target.domain.name };
  }
  if (caller.domain.name !== target.domain.name) {
    return { allowed: false, reason: "cross-domain", callerDomain: caller.domain.name, targetDomain: target.domain.name };
  }
  return {
    allowed: true,
    reason: target.via === "container" ? "container" : "roster",
    callerDomain: caller.domain.name,
    targetDomain: target.domain.name,
  };
}

export function notionWorkScope(
  callerDomain: Domain | undefined,
  pageId: string,
  domains: readonly Domain[],
  workspaceHints: readonly string[] = [],
): NotionScopeVerdict {
  if (!callerDomain) return { allowed: false, reason: "caller-unassigned" };
  let target = notionPageDomain(undefined, pageId, domains);
  for (const ws of workspaceHints) {
    if (target.domain) break;
    target = notionPageDomain(ws, pageId, domains);
  }
  if (!target.domain) return { allowed: false, reason: "target-unassigned", callerDomain: callerDomain.name };
  if (target.domain.name !== callerDomain.name) {
    return { allowed: false, reason: "cross-domain", callerDomain: callerDomain.name, targetDomain: target.domain.name };
  }
  return {
    allowed: true,
    reason: target.via === "container" ? "container" : "roster",
    callerDomain: callerDomain.name,
    targetDomain: target.domain.name,
  };
}

export async function assertNotionWorkPageAllowed(
  ctx: BindableContext,
  pageId: string,
  callerDomain: Domain | undefined,
  domains: readonly Domain[],
  workspaceHints: readonly string[] = [],
  deps?: NotionScopeDeps,
): Promise<void> {
  const verdict = notionWorkScope(callerDomain, pageId, domains, workspaceHints);
  if (verdict.allowed) return;
  await auditNotionReadRefusal(ctx, pageId, verdict.reason, verdict, deps);
  throw new ChannelScopeError(notionScopeRefusal(pageId, verdict));
}

export function notionBlockRefusal(blockId: string, callerDomain: string | undefined): string {
  const scope = callerDomain ? `domain "${callerDomain}"` : "this session's";
  return (
    `Notion block "${blockId}" could not be resolved to a page in ${scope} read scope, so it is refused. ` +
    "A block is only readable through a page the agent's memory domain owns — pass `page` (and let the " +
    "sweep find the discussion), or add the owning page to the domain's `channels`."
  );
}

export function notionScopeRefusal(pageId: string, verdict: NotionScopeVerdict): string {
  const scope = verdict.callerDomain ? `domain "${verdict.callerDomain}"` : "this page's (no domain owns this session's page)";
  return (
    `Notion page "${pageId}" is not in ${scope} read scope. The agent may only read pages in its ` +
    "memory domain (memory/domains.ts). Add the page to the domain's `channels` as " +
    "`notion/<workspace>/<page>`, or claim the workspace in `containers`, to grant it."
  );
}

export function notionPageOrBlockRefusal(id: string, verdict: NotionScopeVerdict, resolvedPage: string | null): string {
  if (resolvedPage) {
    const scope = verdict.callerDomain ? `domain "${verdict.callerDomain}"` : "this session's";
    return (
      `Notion id "${id}" resolved to its parent page "${resolvedPage}", but that page is not in ${scope} read scope either ` +
      `(${verdict.reason}). Add "${resolvedPage}" to the domain's \`channels\` as \`notion/<workspace>/<page>\`, or claim the ` +
      "workspace in `containers`, to grant it."
    );
  }
  return (
    `${notionScopeRefusal(id, verdict)} If "${id}" is a discussion/block id rather than a page id, this looks like a block id ` +
    "— automatic resolution to its parent page did not succeed (not a block, no API access, or the hop limit), so try passing " +
    "its parent page id directly."
  );
}

export async function assertNotionPageAllowed(
  ctx: BindableContext,
  pageId: string,
  domains: readonly Domain[],
  deps?: NotionScopeDeps,
): Promise<void> {
  const partition = resolvePartition(ctx);
  const verdict = notionReadScope(partition.surfaceKey, pageId, domains);
  if (verdict.allowed) return;
  await auditNotionReadRefusal(ctx, pageId, verdict.reason, verdict, deps);
  throw new ChannelScopeError(notionScopeRefusal(pageId, verdict));
}

export interface NotionScopeDeps {
  readonly audit?: (entry: Parameters<typeof appendAudit>[0]) => Promise<void>;
}

async function auditNotionReadRefusal(
  ctx: BindableContext,
  target: string,
  reason: string,
  verdict: { readonly callerDomain?: string; readonly targetDomain?: string },
  deps?: NotionScopeDeps,
  resolvedPage?: string | null,
): Promise<void> {
  const partition = resolvePartition(ctx);
  const principalId = bindFrom(ctx).principalId;
  const foreignCaller = partition.platform !== "notion";
  await (deps?.audit ?? appendAudit)({
    org: partition.org,
    platform: "notion",
    workspace: foreignCaller ? "unknown" : partition.workspace,
    surface: foreignCaller ? "unknown" : partition.surface,
    ...(principalId ? { principalId } : {}),
    action: "read.refused",
    detail: {
      target,
      reason,
      callerDomain: verdict.callerDomain ?? null,
      targetDomain: verdict.targetDomain ?? null,
      callerSurfaceKey: partition.surfaceKey,
      ...(resolvedPage !== undefined ? { resolvedPage } : {}),
    },
  });
}

interface NotionResolveOutcome {
  readonly allowed: boolean;
  readonly verdict: NotionScopeVerdict;
  readonly resolvedPage?: string | null;
}

async function resolveNotionReadTarget(
  callerSurfaceKey: string,
  requestedId: string,
  domains: readonly Domain[],
  resolveOwningPage: (id: string) => Promise<string | undefined>,
): Promise<NotionResolveOutcome> {
  const direct = notionReadScope(callerSurfaceKey, requestedId, domains);
  if (direct.allowed) return { allowed: true, verdict: direct };
  const owning = await resolveOwningPage(requestedId);
  if (!owning) return { allowed: false, verdict: direct, resolvedPage: null };
  const viaPage = notionReadScope(callerSurfaceKey, owning, domains);
  return { allowed: viaPage.allowed, verdict: viaPage, resolvedPage: owning };
}

export async function assertNotionBlockAllowed(
  ctx: BindableContext,
  blockId: string,
  domains: readonly Domain[],
  resolveOwningPage: (blockId: string) => Promise<string | undefined>,
  deps?: NotionScopeDeps,
): Promise<void> {
  const partition = resolvePartition(ctx);
  const res = await resolveNotionReadTarget(partition.surfaceKey, blockId, domains, resolveOwningPage);
  if (res.allowed) return;
  if (res.resolvedPage) {
    await auditNotionReadRefusal(ctx, blockId, `block:${res.verdict.reason}`, res.verdict, deps, res.resolvedPage);
  } else {
    await auditNotionReadRefusal(ctx, blockId, "block-unresolvable", res.verdict, deps);
  }
  throw new ChannelScopeError(notionBlockRefusal(blockId, res.verdict.callerDomain));
}

export async function assertNotionPageAllowedOrResolveBlock(
  ctx: BindableContext,
  requestedId: string,
  domains: readonly Domain[],
  resolveOwningPage: (id: string) => Promise<string | undefined>,
  deps?: NotionScopeDeps,
): Promise<string> {
  const partition = resolvePartition(ctx);
  const res = await resolveNotionReadTarget(partition.surfaceKey, requestedId, domains, resolveOwningPage);
  if (res.allowed) return res.resolvedPage ?? requestedId;
  await auditNotionReadRefusal(
    ctx,
    requestedId,
    res.resolvedPage ? `page-via-block:${res.verdict.reason}` : "page-block-unresolvable",
    res.verdict,
    deps,
    res.resolvedPage ?? null,
  );
  throw new ChannelScopeError(notionPageOrBlockRefusal(requestedId, res.verdict, res.resolvedPage ?? null));
}
