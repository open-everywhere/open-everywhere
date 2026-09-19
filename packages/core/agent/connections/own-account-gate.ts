import { auditToolAction } from "../audit/tool-action.js";
import { getConfig } from "../access/config.js";
import { domainsAdmitCredentialGrant, isCredentialGrantConnector } from "../access/credential-grant.js";
import { credentialGrantsInReach } from "../access/credential-grant-reach.js";
import { grantDomainScopeKey } from "../access/credential-grant-scope.js";
import { requesterThisTurn } from "../access/requester-identity.js";
import { requesterMessagesThisTurn } from "../access/requester-messages.js";
import { askBodyOf } from "../hooks/own-account-ask.js";
import { currentSessionId, currentTurnId, delegationRootSessionId, isSubagentChildContext, type BindableContext } from "../identity/binding.js";
import { tryPrincipalKey } from "../identity/principal-key.js";
import type { Domain } from "../memory/domain.js";
import { resolvePartition } from "../memory/partition.js";
import { credentialGrantStateRefusal, type CredentialGrantRow } from "../operational/credential-grant-rows.js";
import { adoptedOwnAccountAsk } from "./own-account-carriage.js";
import {
  actingIdentityAuditDetail,
  decideActingIdentity,
  namedOwnAccountVendor,
  type ActingIdentityVerdict,
  type OwnAccountAsk,
  type OwnAccountVendor,
} from "./own-account-ask.js";

export interface ConnectorActingIdentityDeps {
  readonly vendor: OwnAccountVendor;
  readonly ask: () => OwnAccountAsk | undefined;
  readonly grants: () => Promise<readonly CredentialGrantRow[]>;
  readonly askerPrincipalId?: string;
  readonly consentRouteAvailable: () => boolean;
  readonly deploymentAdmitsGrant: () => boolean;
  readonly nowIso: string;
  readonly tool: string;
  readonly audit: (detail: Record<string, unknown>) => Promise<void>;
  readonly callerCanSpendPersonal?: boolean;
}

export const CONNECTOR_ACTING_IDENTITY_ACTION = "connector.acting_identity";

export function holdsPersonalGrant(rows: readonly CredentialGrantRow[], connector: string, ownerPrincipalId: string | undefined, nowIso: string): boolean {
  if (ownerPrincipalId === undefined) return false;
  return rows.some(
    (row) => row.connector === connector && row.ownerPrincipalId === ownerPrincipalId && credentialGrantStateRefusal(row, nowIso) === undefined,
  );
}

export async function decideConnectorActingIdentity(deps: ConnectorActingIdentityDeps): Promise<ActingIdentityVerdict> {
  const ask = safeAsk(deps.ask);
  const personalGrantHeld = ask === undefined ? false : holdsPersonalGrant(await safeGrants(deps.grants), ask.connector, deps.askerPrincipalId, deps.nowIso);
  const verdict = decideActingIdentity({
    callerCanSpendPersonal: deps.callerCanSpendPersonal ?? false,
    connector: deps.vendor.connector,
    ...(ask === undefined ? {} : { ask }),
    consentRouteAvailable: ask === undefined ? false : safeRouteFact(deps.consentRouteAvailable),
    deploymentAdmitsGrant: ask === undefined ? false : safeRouteFact(deps.deploymentAdmitsGrant),
    personalGrantHeld,
  });
  await deps.audit(actingIdentityAuditDetail(verdict, deps.vendor.connector, deps.tool)).catch(() => undefined);
  return verdict;
}

function safeAsk(read: () => OwnAccountAsk | undefined): OwnAccountAsk | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

async function safeGrants(read: () => Promise<readonly CredentialGrantRow[]>): Promise<readonly CredentialGrantRow[]> {
  try {
    return await read();
  } catch {
    return [];
  }
}

function safeRouteFact(read: () => boolean): boolean {
  try {
    return read();
  } catch {
    return false;
  }
}

function ownAccountAskForTurn(ctx: BindableContext, vendors: readonly OwnAccountVendor[]): OwnAccountAsk | undefined {
  const adopted = adoptedOwnAccountAsk(ctx, vendors);
  if (adopted !== undefined) return adopted;
  try {
    if (isSubagentChildContext(ctx)) return undefined;
  } catch {
    return undefined;
  }
  return ownAccountAskFromMessages(requesterMessagesThisTurn(), vendors);
}

export function ownAccountAskFromMessages(messages: readonly string[], vendors: readonly OwnAccountVendor[]): OwnAccountAsk | undefined {
  const bodies = messages.map((message) => askBodyOf(message)).filter((body): body is string => body !== undefined);
  return namedOwnAccountVendor(bodies, vendors);
}

function safeDomains(): readonly Domain[] {
  try {
    return getConfig().loadDomains();
  } catch {
    return [];
  }
}

function domainsForCtx(ctx: BindableContext): readonly Domain[] {
  try {
    const p = resolvePartition(ctx);
    const names = new Set(getConfig().domainsForSurface({ surface: p.surface ?? p.surfaceKey, workspaceKey: p.workspaceKey }));
    return safeDomains().filter((d) => names.has(d.name));
  } catch {
    return [];
  }
}

function grantLookupScope(ctx: BindableContext): string | undefined {
  const root = delegationRootSessionId(ctx);
  if (root !== undefined && root.length > 0) return root;
  if (isSubagentChildContext(ctx)) return undefined;
  const own = currentSessionId(ctx);
  return own !== undefined && own.length > 0 ? own : undefined;
}

function askerKey(ctx: BindableContext): string | undefined {
  try {
    const p = resolvePartition(ctx);
    const verdict = requesterThisTurn(currentTurnId(ctx));
    return verdict.kind === "requester" ? tryPrincipalKey(p.platform, p.workspace, verdict.principalId) : undefined;
  } catch {
    return undefined;
  }
}

export async function connectorActingIdentityForTurn(ctx: BindableContext, vendor: OwnAccountVendor, tool: string): Promise<ActingIdentityVerdict> {
  const asker = askerKey(ctx);
  return await decideConnectorActingIdentity({
    ask: () => ownAccountAskForTurn(ctx, [vendor]),
    ...(asker === undefined ? {} : { askerPrincipalId: asker }),
    audit: async (detail) => {
      await auditToolAction(ctx, CONNECTOR_ACTING_IDENTITY_ACTION, detail);
    },
    consentRouteAvailable: () => domainsAdmitCredentialGrant(domainsForCtx(ctx), vendor.connector),
    deploymentAdmitsGrant: () => isCredentialGrantConnector(vendor.connector),
    grants: async () => {
      const scope = grantLookupScope(ctx);
      if (scope === undefined) return [];
      return await credentialGrantsInReach(resolvePartition(ctx).org, scope, grantDomainScopeKey(ctx), new Date().toISOString());
    },
    nowIso: new Date().toISOString(),
    tool,
    vendor,
  });
}
