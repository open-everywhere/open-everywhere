import {
  appendAudit,
  bindFrom,
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
  const claim = domains.find((d) => d.containers?.includes(`notion/${workspace}`));
  if (claim) return { domain: claim, via: "container" };
  return { via: "none" };
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
): Promise<void> {
  const partition = resolvePartition(ctx);
  const principalId = bindFrom(ctx).principalId;
  await (deps?.audit ?? appendAudit)({
    org: partition.org,
    platform: "notion",
    workspace: partition.workspace,
    surface: partition.surface,
    ...(principalId ? { principalId } : {}),
    action: "read.refused",
    detail: {
      target,
      reason,
      callerDomain: verdict.callerDomain ?? null,
      targetDomain: verdict.targetDomain ?? null,
      callerSurfaceKey: partition.surfaceKey,
    },
  });
}

export async function assertNotionBlockAllowed(
  ctx: BindableContext,
  blockId: string,
  domains: readonly Domain[],
  resolveOwningPage: (blockId: string) => Promise<string | undefined>,
  deps?: NotionScopeDeps,
): Promise<void> {
  const partition = resolvePartition(ctx);
  const direct = notionReadScope(partition.surfaceKey, blockId, domains);
  if (direct.allowed) return;
  const owning = await resolveOwningPage(blockId);
  if (owning) {
    const viaPage = notionReadScope(partition.surfaceKey, owning, domains);
    if (viaPage.allowed) return;
    await auditNotionReadRefusal(ctx, blockId, `block:${viaPage.reason}`, viaPage, deps);
    throw new ChannelScopeError(notionBlockRefusal(blockId, viaPage.callerDomain));
  }
  await auditNotionReadRefusal(ctx, blockId, "block-unresolvable", direct, deps);
  throw new ChannelScopeError(notionBlockRefusal(blockId, direct.callerDomain));
}
