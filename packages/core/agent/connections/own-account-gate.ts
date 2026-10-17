import { auditToolAction } from "../audit/tool-action.js";
import { getConfig } from "../access/config.js";
import { domainsAdmitCredentialGrant, isCredentialGrantConnector } from "../access/credential-grant.js";
import { credentialGrantsInReach, domainScopeKeyInReach, sessionScopeKeyInReach } from "../access/credential-grant-reach.js";
import { requesterThisTurn } from "../access/requester-identity.js";
import { requesterMessagesThisTurn } from "../access/requester-messages.js";
import { askBodyOf } from "../hooks/own-account-ask.js";
import { currentSessionId, currentTurnId, isSubagentChildContext, type BindableContext } from "../identity/binding.js";
import { tryPrincipalKey } from "../identity/principal-key.js";
import type { Domain } from "../memory/domain.js";
import { resolvePartition } from "../memory/partition.js";
import { credentialGrantStateRefusal, type CredentialGrantRow } from "../operational/credential-grant-rows.js";
import { adoptedOwnAccountAsk } from "./own-account-carriage.js";
import { ownAccountVendorFor } from "./own-account-vendors.js";
import {
  actingIdentityAuditDetail,
  decideActingIdentity,
  namedOwnAccountVendor,
  type ActingIdentityVerdict,
  type OwnAccountAsk,
  type OwnAccountVendor,
} from "./own-account-ask.js";
import type { AuditDetail } from "../audit/scrubbed-text.js";

export interface ConnectorActingIdentityDeps {
  readonly vendor: OwnAccountVendor;
  readonly ask: () => OwnAccountAsk | undefined;
  readonly grants: () => Promise<readonly CredentialGrantRow[]>;
  readonly askerPrincipalId?: string;
  readonly consentRouteAvailable: () => boolean;
  readonly deploymentAdmitsGrant: () => boolean;
  readonly nowIso: string;
  readonly tool: string;
  readonly audit: (detail: AuditDetail) => Promise<void>;
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

function askerKey(ctx: BindableContext): string | undefined {
  try {
    const p = resolvePartition(ctx);
    const verdict = requesterThisTurn(currentTurnId(ctx));
    return verdict.kind === "requester" ? tryPrincipalKey(p.platform, p.workspace, verdict.principalId) : undefined;
  } catch {
    return undefined;
  }
}

function actingIdentityDepsForTurn(ctx: BindableContext, vendor: OwnAccountVendor, tool: string): ConnectorActingIdentityDeps {
  const asker = askerKey(ctx);
  return {
    ask: () => ownAccountAskForTurn(ctx, [vendor]),
    ...(asker === undefined ? {} : { askerPrincipalId: asker }),
    audit: async (detail) => {
      await auditToolAction(ctx, CONNECTOR_ACTING_IDENTITY_ACTION, detail);
    },
    consentRouteAvailable: () => domainsAdmitCredentialGrant(domainsForCtx(ctx), vendor.connector),
    deploymentAdmitsGrant: () => isCredentialGrantConnector(vendor.connector),
    grants: async () => {
      const scope = sessionScopeKeyInReach(ctx);
      if (scope === undefined) return [];
      return await credentialGrantsInReach(resolvePartition(ctx).org, scope, domainScopeKeyInReach(ctx), new Date().toISOString());
    },
    nowIso: new Date().toISOString(),
    tool,
    vendor,
  };
}

export async function connectorActingIdentityForTurn(ctx: BindableContext, vendor: OwnAccountVendor, tool: string): Promise<ActingIdentityVerdict> {
  return await decideConnectorActingIdentity(actingIdentityDepsForTurn(ctx, vendor, tool));
}

async function routeActingIdentityForTurn(
  ctx: BindableContext,
  vendor: OwnAccountVendor,
  route: string,
  writeRow: boolean,
): Promise<ActingIdentityVerdict> {
  const deps = actingIdentityDepsForTurn(ctx, vendor, route);
  return await decideConnectorActingIdentity(writeRow ? deps : { ...deps, audit: async () => undefined });
}

export function ownAccountRouteLabel(viaConnections: readonly string[]): string {
  return `egress:${[...new Set(viaConnections)].sort().join(",")}`;
}

const routeRefusalWritten = new Set<string>();
const ROUTE_REFUSAL_MEMO_MAX = 512;

export async function noteOwnAccountRouteRefusal(
  ctx: BindableContext,
  refusals: readonly { readonly connector: string; readonly viaConnection: string }[],
): Promise<ActingIdentityVerdict | undefined> {
  const first = refusals[0];
  if (first === undefined) return undefined;
  return await routeActingIdentityForTurn(
    ctx,
    ownAccountVendorFor(first.connector),
    ownAccountRouteLabel(refusals.map((r) => r.viaConnection)),
    !memoHolds(ctx, first.connector),
  );
}

function memoHolds(ctx: BindableContext, connector: string): boolean {
  let session: string | undefined;
  try {
    session = currentSessionId(ctx);
  } catch {
    return false;
  }
  if (session === undefined) return false;
  const key = [session, connector].join("\u0000");
  if (routeRefusalWritten.has(key)) return true;
  if (routeRefusalWritten.size >= ROUTE_REFUSAL_MEMO_MAX) routeRefusalWritten.clear();
  routeRefusalWritten.add(key);
  return false;
}
