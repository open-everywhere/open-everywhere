import { resolvePartition } from "../memory/partition.js";
import { auditToolAction } from "../audit/tool-action.js";
import { actingPrincipalId, bindFrom, currentSessionId, currentTurnId, delegationRootSessionId, unattendedFrom, type BindableContext } from "../identity/binding.js";
import { adoptedOwnAccountAsk } from "../connections/own-account-carriage.js";
import { credentialGrantConnectors } from "./credential-grant.js";
import { ownAccountEgressRefusalText, resolveAccess, type EffectiveAccess, type ResolveRequest, type SessionMode } from "./resolver.js";
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

function ownAccountAskFor(ctx: BindableContext): { readonly connector: string } | undefined {
  try {
    const ask = adoptedOwnAccountAsk(
      ctx,
      credentialGrantConnectors().map((connector) => ({ connector })),
    );
    return ask === undefined ? undefined : { connector: ask.connector };
  } catch {
    return undefined;
  }
}

const ownAccountRefusalAudited = new Set<string>();
const OWN_ACCOUNT_AUDIT_MEMO_MAX = 512;

function auditOwnAccountEgressRefusal(ctx: BindableContext, access: EffectiveAccess): void {
  const refusals = access.ownAccountEgressRefusals ?? [];
  if (refusals.length === 0) return;
  const session = currentSessionId(ctx) ?? delegationRootSessionId(ctx);
  const turn = currentTurnId(ctx);
  if (session !== undefined && turn !== undefined) {
    const key = [session, turn, refusals[0]!.connector].join("\u0000");
    if (ownAccountRefusalAudited.has(key)) return;
    if (ownAccountRefusalAudited.size >= OWN_ACCOUNT_AUDIT_MEMO_MAX) ownAccountRefusalAudited.clear();
    ownAccountRefusalAudited.add(key);
  }
  void auditToolAction(ctx, OWN_ACCOUNT_EGRESS_REFUSAL_ACTION, {
    connector: refusals[0]!.connector,
    hosts: refusals.map((r) => r.host),
    viaConnections: [...new Set(refusals.map((r) => r.viaConnection))].sort(),
    reason: ownAccountEgressRefusalText(refusals[0]!),
  }).catch(() => undefined);
}

export const OWN_ACCOUNT_EGRESS_REFUSAL_ACTION = "egress.own_account_refusal";

export function resolveAccessFor(ctx: BindableContext): EffectiveAccess {
  const cfg = getConfig();
  const ask = ownAccountAskFor(ctx);
  const access = resolveAccess(
    { ...buildResolveRequest(ctx), ...(ask === undefined ? {} : { ownAccountAsk: ask }) },
    cfg.loadBundles(),
    cfg.loadBindings(),
    cfg.pluginRegistry,
    cfg.loadConnectorCredentials?.() ?? [],
  );
  auditOwnAccountEgressRefusal(ctx, access);
  return access;
}
