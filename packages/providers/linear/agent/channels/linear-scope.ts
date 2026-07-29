import {
  appendAudit,
  bindFrom,
  resolveDomainForChannel,
  resolvePartition,
  ChannelScopeError,
  type BindableContext,
  type Domain,
} from "@open-everywhere/core/agent/adapter-api.js";

export type LinearScopeDirection = "read" | "write";

export type LinearScopeReason =
  | "own-issue"
  | "roster"
  | "container"
  | "cross-domain"
  | "target-unresolvable"
  | "target-unassigned"
  | "caller-unassigned";

export interface LinearScopeVerdict {
  readonly allowed: boolean;
  readonly reason: LinearScopeReason;
  readonly callerDomain?: string;
  readonly targetDomain?: string;
  readonly targetTeam?: string;
}

function splitLinearKey(surfaceKey: string): { org?: string; surface?: string } {
  const parts = surfaceKey.split("/");
  if (parts.length !== 3 || parts[0] !== "linear") return {};
  return { org: parts[1] || undefined, surface: parts[2] || undefined };
}

function sameRef(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function linearIssueScope(
  callerSurfaceKey: string,
  ownIssueRefs: readonly string[],
  targetRef: string,
  targetTeamId: string | undefined,
  domains: readonly Domain[],
): LinearScopeVerdict {
  const { org } = splitLinearKey(callerSurfaceKey);
  const caller = resolveDomainForChannel(callerSurfaceKey, domains);
  const callerName = caller.domain?.name;

  if (targetRef.trim().length > 0 && ownIssueRefs.some((ref) => sameRef(ref, targetRef))) {
    return { allowed: true, reason: "own-issue", ...(callerName ? { callerDomain: callerName, targetDomain: callerName } : {}) };
  }

  if (!callerName) return { allowed: false, reason: "caller-unassigned" };

  if (!targetTeamId || !org) return { allowed: false, reason: "target-unresolvable", callerDomain: callerName };
  const target = resolveDomainForChannel(`linear/${org}/${targetTeamId}`, domains);
  if (!target.domain) return { allowed: false, reason: "target-unassigned", callerDomain: callerName, targetTeam: targetTeamId };
  if (target.domain.name !== callerName) {
    return { allowed: false, reason: "cross-domain", callerDomain: callerName, targetDomain: target.domain.name, targetTeam: targetTeamId };
  }
  return {
    allowed: true,
    reason: target.via === "roster" ? "roster" : "container",
    callerDomain: callerName,
    targetDomain: target.domain.name,
    targetTeam: targetTeamId,
  };
}

export function linearScopeRefusal(targetRef: string, verdict: LinearScopeVerdict, direction: LinearScopeDirection = "read"): string {
  const scope = verdict.callerDomain
    ? `domain "${verdict.callerDomain}"`
    : "this session's (no domain owns the surface this session was woken on)";
  const why =
    verdict.reason === "target-unresolvable"
      ? "Its team could not be established, and a target whose team is unknown is refused rather than assumed."
      : verdict.reason === "target-unassigned"
        ? "Its team is in no memory domain, and an unassigned team is refused rather than assumed."
        : "";
  const may = direction === "write" ? "may only act on Linear entities on teams" : "may only read issues on teams";
  return (
    `Linear target "${targetRef}" is not in ${scope} ${direction} scope, so it is refused. ${why} ` +
    `The agent ${may} in its memory domain (memory/domains.ts). Add the team to ` +
    "the domain's `channels` as `linear/<organization_id>/<team_id>`, or claim the whole workspace in " +
    "`containers` as `linear/<organization_id>`, to grant it."
  ).replace(/\s{2,}/g, " ");
}

export interface LinearScopeDeps {
  readonly audit?: (entry: Parameters<typeof appendAudit>[0]) => Promise<void>;
}

type AuthAttrs = Readonly<Record<string, string | readonly string[]>> | undefined;

function linearAttr(a: AuthAttrs, keys: readonly string[]): string | undefined {
  if (!a) return undefined;
  for (const k of keys) {
    const v = a[k];
    if (typeof v === "string" && v.length > 0) return v;
    if (Array.isArray(v) && typeof v[0] === "string" && v[0].length > 0) return v[0];
  }
  return undefined;
}

export function currentTurnIssueRefs(ctx: BindableContext): string[] {
  const a = (ctx.session?.auth?.current ?? ctx.session?.auth?.initiator)?.attributes as AuthAttrs;
  const refs = [linearAttr(a, ["issue_id", "issueId"]), linearAttr(a, ["issue_identifier", "issueIdentifier"])];
  return refs.filter((r): r is string => typeof r === "string" && r.trim().length > 0);
}

async function auditLinearRefusal(
  ctx: BindableContext,
  target: string,
  verdict: LinearScopeVerdict,
  direction: LinearScopeDirection,
  deps?: LinearScopeDeps,
): Promise<void> {
  const partition = resolvePartition(ctx);
  const principalId = bindFrom(ctx).principalId;
  await (deps?.audit ?? appendAudit)({
    org: partition.org,
    platform: "linear",
    workspace: partition.workspace,
    surface: partition.surface,
    ...(principalId ? { principalId } : {}),
    action: `${direction}.refused`,
    detail: {
      target,
      reason: verdict.reason,
      callerDomain: verdict.callerDomain ?? null,
      targetDomain: verdict.targetDomain ?? null,
      targetTeam: verdict.targetTeam ?? null,
      callerSurfaceKey: partition.surfaceKey,
    },
  });
}

export async function assertLinearIssueAllowed(
  ctx: BindableContext,
  issueRef: string,
  domains: readonly Domain[],
  resolveIssueTeam: (issueRef: string) => Promise<string | undefined>,
  deps?: LinearScopeDeps,
): Promise<void> {
  return assertLinearIssueScope(ctx, issueRef, domains, resolveIssueTeam, "read", deps);
}

export async function assertLinearIssueWriteAllowed(
  ctx: BindableContext,
  issueRef: string,
  domains: readonly Domain[],
  resolveIssueTeam: (issueRef: string) => Promise<string | undefined>,
  deps?: LinearScopeDeps,
): Promise<void> {
  return assertLinearIssueScope(ctx, issueRef, domains, resolveIssueTeam, "write", deps);
}

async function assertLinearIssueScope(
  ctx: BindableContext,
  issueRef: string,
  domains: readonly Domain[],
  resolveIssueTeam: (issueRef: string) => Promise<string | undefined>,
  direction: LinearScopeDirection,
  deps?: LinearScopeDeps,
): Promise<void> {
  const partition = resolvePartition(ctx);
  const own = currentTurnIssueRefs(ctx);
  const pure = linearIssueScope(partition.surfaceKey, own, issueRef, undefined, domains);
  if (pure.allowed) return;
  if (pure.reason === "caller-unassigned") {
    await auditLinearRefusal(ctx, issueRef, pure, direction, deps);
    throw new ChannelScopeError(linearScopeRefusal(issueRef, pure, direction));
  }
  const teamId = await resolveIssueTeam(issueRef);
  const verdict = linearIssueScope(partition.surfaceKey, own, issueRef, teamId, domains);
  if (verdict.allowed) return;
  await auditLinearRefusal(ctx, issueRef, verdict, direction, deps);
  throw new ChannelScopeError(linearScopeRefusal(issueRef, verdict, direction));
}

export function linearTeamScope(
  callerSurfaceKey: string,
  targetTeamId: string | undefined,
  domains: readonly Domain[],
): LinearScopeVerdict {
  const { org } = splitLinearKey(callerSurfaceKey);
  const caller = resolveDomainForChannel(callerSurfaceKey, domains);
  const callerName = caller.domain?.name;
  if (!callerName) return { allowed: false, reason: "caller-unassigned" };
  if (!targetTeamId || !org) return { allowed: false, reason: "target-unresolvable", callerDomain: callerName };
  const target = resolveDomainForChannel(`linear/${org}/${targetTeamId}`, domains);
  if (!target.domain) return { allowed: false, reason: "target-unassigned", callerDomain: callerName, targetTeam: targetTeamId };
  if (target.domain.name !== callerName) {
    return { allowed: false, reason: "cross-domain", callerDomain: callerName, targetDomain: target.domain.name, targetTeam: targetTeamId };
  }
  return {
    allowed: true,
    reason: target.via === "roster" ? "roster" : "container",
    callerDomain: callerName,
    targetDomain: target.domain.name,
    targetTeam: targetTeamId,
  };
}

export async function assertLinearTeamWriteAllowed(
  ctx: BindableContext,
  target: string,
  domains: readonly Domain[],
  resolveTeamId: (target: string) => Promise<string | undefined>,
  deps?: LinearScopeDeps,
): Promise<void> {
  const partition = resolvePartition(ctx);
  const pure = linearTeamScope(partition.surfaceKey, undefined, domains);
  if (pure.reason === "caller-unassigned") {
    await auditLinearRefusal(ctx, target, pure, "write", deps);
    throw new ChannelScopeError(linearScopeRefusal(target, pure, "write"));
  }
  const teamId = await resolveTeamId(target);
  const verdict = linearTeamScope(partition.surfaceKey, teamId, domains);
  if (verdict.allowed) return;
  await auditLinearRefusal(ctx, target, verdict, "write", deps);
  throw new ChannelScopeError(linearScopeRefusal(target, verdict, "write"));
}
