import { appendAudit } from "../audit/audit.js";
import { bindFrom, turnOriginPlatform, currentSessionId, type BindableContext } from "../identity/binding.js";
import { domainForChannel, type Domain } from "../memory/domain.js";
import { resolvePartition } from "../memory/partition.js";

export type ReadScopeReason = "cross-domain" | "caller-unassigned";

export interface ReadScopeAuditDeps {
  readonly audit?: (entry: Parameters<typeof appendAudit>[0]) => Promise<void>;
}

export interface ReadScopeRefusal {
  readonly platform: string;
  readonly surfaceId: string;
  readonly callerKey: string;
  readonly callerDomain?: string;
  readonly domains: readonly Domain[];
  readonly boundary?: string;
}

function targetDomainOf(refusal: ReadScopeRefusal): string | undefined {
  const parts = refusal.callerKey.split("/");
  if (parts.length !== 3 || parts[0] !== refusal.platform) return undefined;
  return domainForChannel(`${parts[0]}/${parts[1]}/${refusal.surfaceId}`, refusal.domains)?.name;
}

function stampedWorkspaceSurface(partition: { platform: string; workspace: string; surface: string }, rowPlatform: string): { workspace: string; surface: string } {
  const foreignCaller = partition.platform !== rowPlatform;
  return { workspace: foreignCaller ? "unknown" : partition.workspace, surface: foreignCaller ? "unknown" : partition.surface };
}

export async function auditChannelReadRefusal(
  ctx: BindableContext,
  refusal: ReadScopeRefusal,
  deps?: ReadScopeAuditDeps,
): Promise<void> {
  try {
    const partition = resolvePartition(ctx);
    const principalId = bindFrom(ctx).principalId;
    await (deps?.audit ?? appendAudit)({
      org: partition.org,
      platform: refusal.platform,
      ...stampedWorkspaceSurface(partition, refusal.platform),
      ...(principalId ? { principalId } : {}),
      action: "read.refused",
      detail: {
        target: refusal.surfaceId,
        reason: refusal.callerDomain ? "cross-domain" : "caller-unassigned",
        callerDomain: refusal.callerDomain ?? null,
        targetDomain: targetDomainOf(refusal) ?? null,
        callerSurfaceKey: refusal.callerKey,
        ...(refusal.boundary ? { boundary: refusal.boundary } : {}),
      },
    });
  } catch (err) {
    console.warn(`[open-everywhere:audit] read.refused row for ${refusal.platform} was not written: ${String(err)}`);
  }
}

async function auditFenceRefusal(
  ctx: BindableContext,
  verb: "sources_refused" | "origin_refused",
  target: string,
  deps?: ReadScopeAuditDeps,
): Promise<void> {
  const action = `${target}.${verb}`;
  try {
    const partition = resolvePartition(ctx);
    const principalId = bindFrom(ctx).principalId;
    await (deps?.audit ?? appendAudit)({
      org: partition.org,
      platform: target,
      ...stampedWorkspaceSurface(partition, target),
      ...(principalId ? { principalId } : {}),
      action,
      detail: { target, origin: turnOriginPlatform(ctx) ?? null, sessionId: currentSessionId(ctx) ?? null },
    });
  } catch (err) {
    console.warn(`[open-everywhere:audit] ${action} row for ${target} was not written: ${String(err)}`);
  }
}

export async function auditSourcesGateRefusal(ctx: BindableContext, target: string, deps?: ReadScopeAuditDeps): Promise<void> {
  await auditFenceRefusal(ctx, "sources_refused", target, deps);
}

export async function auditOriginFenceRefusal(ctx: BindableContext, target: string, deps?: ReadScopeAuditDeps): Promise<void> {
  await auditFenceRefusal(ctx, "origin_refused", target, deps);
}
