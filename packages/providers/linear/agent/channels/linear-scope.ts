import {
  appendAudit,
  bindFrom,
  parseSurfaceKeyEntry,
  resolveDomainForChannel,
  resolvePartition,
  surfaceKeyEntryMatches,
  ChannelScopeError,
  type BindableContext,
  type Domain,
  type SurfaceKeyEntry,
} from "@open-everywhere/core/agent/adapter-api.js";

export type LinearScopeDirection = "read" | "write";

export type LinearScopeReason =
  | "own-issue"
  | "roster"
  | "container"
  | "cross-domain"
  | "target-unresolvable"
  | "target-unassigned"
  | "caller-unassigned"
  | "work-grant"
  | "work-grant-ambiguous"
  | "outside-work-grant";

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

function linearWorkGrantEntries(workGrants: readonly string[]): readonly SurfaceKeyEntry[] {
  const parsed: SurfaceKeyEntry[] = [];
  for (const entry of workGrants) {
    const e = parseSurfaceKeyEntry(entry);
    if (e && e.platform === "linear" && e.kind !== "group") parsed.push(e);
  }
  return parsed;
}

export function linearWorkGrantOrg(workGrants: readonly string[]): string | undefined {
  const orgs = new Set(linearWorkGrantEntries(workGrants).map((e) => e.tenant));
  return orgs.size === 1 ? [...orgs][0] : undefined;
}

type LinearWriteOrg =
  | { readonly ok: true; readonly org: string; readonly via: "caller-key"; readonly grants: readonly SurfaceKeyEntry[] }
  | { readonly ok: true; readonly org: string; readonly via: "work-grant"; readonly grants: readonly SurfaceKeyEntry[] }
  | { readonly ok: false; readonly reason: "target-unresolvable" | "work-grant-ambiguous" };

function linearWriteOrg(callerSurfaceKey: string, workGrants: readonly string[]): LinearWriteOrg {
  const grants = linearWorkGrantEntries(workGrants);
  const { org } = splitLinearKey(callerSurfaceKey);
  if (org) return { ok: true, org, via: "caller-key", grants };
  if (grants.length === 0) return { ok: false, reason: "target-unresolvable" };
  const granted = linearWorkGrantOrg(workGrants);
  if (!granted) return { ok: false, reason: "work-grant-ambiguous" };
  return { ok: true, org: granted, via: "work-grant", grants };
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
        : verdict.reason === "work-grant-ambiguous"
          ? "This scope holds a Linear work-surface grant in MORE THAN ONE workspace, so the destination workspace is ambiguous and is refused rather than guessed."
          : verdict.reason === "outside-work-grant"
            ? "This scope holds a Linear work-surface grant, and that grant does not name this team."
            : "";
  const may = direction === "write" ? "may only act on Linear entities on teams" : "may only read issues on teams";
  const workGrant =
    direction === "write"
      ? " If this session was woken on another surface, the Linear WORK-SURFACE grant is what lets it file here: add " +
        '`workSurfaces: ["linear/<organization_id>/<team_id>"]` to a bundle bound to this scope (agent/access/bundles.ts).'
      : "";
  return (
    `Linear target "${targetRef}" is not in ${scope} ${direction} scope, so it is refused. ${why} ` +
    `The agent ${may} in its memory domain (memory/domains.ts). Add the team to ` +
    "the domain's `channels` as `linear/<organization_id>/<team_id>`, or claim the whole workspace in " +
    `\`containers\` as \`linear/<organization_id>\`, to grant it.${workGrant}`
  ).replace(/\s{2,}/g, " ");
}

export interface LinearScopeDeps {
  readonly audit?: (entry: Parameters<typeof appendAudit>[0]) => Promise<void>;
  readonly workSurfaces?: readonly string[];
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
  workGrants: readonly string[] = [],
): LinearScopeVerdict {
  const caller = resolveDomainForChannel(callerSurfaceKey, domains);
  const callerName = caller.domain?.name;
  if (!callerName) return { allowed: false, reason: "caller-unassigned" };

  const source = linearWriteOrg(callerSurfaceKey, workGrants);
  if (!source.ok) {
    return { allowed: false, reason: source.reason, callerDomain: callerName };
  }
  if (!targetTeamId) return { allowed: false, reason: "target-unresolvable", callerDomain: callerName };
  const targetKey = `linear/${source.org}/${targetTeamId}`;

  if (source.via === "work-grant") {
    if (!source.grants.some((g) => surfaceKeyEntryMatches(g, targetKey))) {
      return { allowed: false, reason: "outside-work-grant", callerDomain: callerName, targetTeam: targetTeamId };
    }
    const granted = resolveDomainForChannel(targetKey, domains);
    if (granted.domain && granted.domain.name !== callerName) {
      return { allowed: false, reason: "cross-domain", callerDomain: callerName, targetDomain: granted.domain.name, targetTeam: targetTeamId };
    }
    return {
      allowed: true,
      reason: "work-grant",
      callerDomain: callerName,
      targetDomain: granted.domain?.name ?? callerName,
      targetTeam: targetTeamId,
    };
  }

  const target = resolveDomainForChannel(targetKey, domains);
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
  resolveTeamId: (target: string, organizationId: string | undefined) => Promise<string | undefined>,
  deps?: LinearScopeDeps,
): Promise<void> {
  const partition = resolvePartition(ctx);
  const workGrants = deps?.workSurfaces ?? [];
  const source = linearWriteOrg(partition.surfaceKey, workGrants);
  const pure = linearTeamScope(partition.surfaceKey, undefined, domains, workGrants);
  if (pure.reason === "caller-unassigned" || !source.ok) {
    await auditLinearRefusal(ctx, target, pure, "write", deps);
    throw new ChannelScopeError(linearScopeRefusal(target, pure, "write"));
  }
  const teamId = await resolveTeamId(target, source.org);
  const verdict = linearTeamScope(partition.surfaceKey, teamId, domains, workGrants);
  if (verdict.allowed) return;
  await auditLinearRefusal(ctx, target, verdict, "write", deps);
  throw new ChannelScopeError(linearScopeRefusal(target, verdict, "write"));
}
