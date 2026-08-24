import {
  credentialGrantDisclosureLine,
  credentialGrantRefusalMessage,
  credentialGrantStateRefusal,
  quotedPurpose,
  type CredentialGrantRefusal,
  type CredentialGrantRow,
} from "../operational/credential-grant-rows.js";
import { getOperationalStore } from "../operational/provider.js";
import { grantableVerb, type GrantedRequest } from "./credential-grant.js";
import { auditGrant, type GrantAuditStamps } from "./credential-grant-flow.js";
import { grantOwnerSubject, type GrantOwnerSubject } from "./credential-grant-owner.js";
import { currentJobWakePosture } from "./job-session-state.js";

export type GrantTransport = (request: GrantedRequest, grant: CredentialGrantRow, owner: GrantOwnerSubject) => Promise<unknown>;

const TRANSPORTS = new Map<string, GrantTransport>();

export function registerGrantTransport(connector: string, transport: GrantTransport): void {
  TRANSPORTS.set(connector, transport);
}

export function grantTransport(connector: string): GrantTransport | undefined {
  return TRANSPORTS.get(connector);
}

export function _resetGrantTransportsForTest(): void {
  TRANSPORTS.clear();
}

export type GrantRoomNotice = (line: string, grant: CredentialGrantRow) => Promise<void>;

let roomNotice: GrantRoomNotice | undefined;

export function registerGrantRoomNotice(notice: GrantRoomNotice): void {
  roomNotice = notice;
}

export function _resetGrantRoomNoticeForTest(): void {
  roomNotice = undefined;
}

export interface GrantCallContext extends GrantAuditStamps {
  readonly scopeKey: string;
  readonly requesterPrincipalId: string | undefined;
  readonly nowMs: number;
}

export type GrantCallResult =
  | { readonly ok: true; readonly disclosure: string; readonly result: unknown }
  | { readonly ok: false; readonly refused: CredentialGrantRefusal; readonly message: string };

export async function runGrantedCall(grantId: string, input: Readonly<Record<string, unknown>>, ctx: GrantCallContext): Promise<GrantCallResult> {
  const store = getOperationalStore();
  const nowIso = new Date(ctx.nowMs).toISOString();
  const grant = await store.getCredentialGrant(ctx.org, grantId);
  if (grant === null) {
    const shape = { ownerSlug: "the owner", resource: "that resource", verb: "that tool" };
    await auditGrant(ctx, "grant.refused", ctx.requesterPrincipalId, { gate: "revoked", grantId });
    return { message: credentialGrantRefusalMessage(shape, "revoked"), ok: false, refused: "revoked" };
  }
  const refuse = async (reason: CredentialGrantRefusal): Promise<GrantCallResult> => {
    await auditGrant(ctx, "grant.refused", ctx.requesterPrincipalId, {
      gate: reason,
      grantId: grant.id,
      owner: grant.ownerPrincipalId,
      verb: grant.verb,
    });
    return { message: credentialGrantRefusalMessage(grant, reason), ok: false, refused: reason };
  };

  if (currentJobWakePosture() === "restricted") return refuse("nonmember_wake");

  const stateRefusal = credentialGrantStateRefusal(grant, nowIso);
  if (stateRefusal !== undefined) return refuse(stateRefusal);
  if (grant.scopeKey !== ctx.scopeKey) return refuse("out_of_scope");
  if (ctx.requesterPrincipalId === undefined) return refuse("unverified_requester");

  const definition = grantableVerb(grant.verb);
  if (definition === undefined) return refuse("no_transport");
  const transport = grantTransport(grant.connector);
  if (transport === undefined) return refuse("no_transport");

  const owner = await grantOwnerSubject(ctx.org, grant.connector, grant.ownerPrincipalId);
  if (owner === undefined) return refuse("owner_unresolvable");

  if (grant.mode === "once") {
    const burned = await store.burnCredentialGrant(ctx.org, grant.id, nowIso);
    if (burned === null) return refuse("burned");
  }

  const request = definition.compose(grant, input);
  const disclosure = credentialGrantDisclosureLine(grant);
  await auditGrant(ctx, "grant.used", ctx.requesterPrincipalId, {
    connector: grant.connector,
    grantId: grant.id,
    mode: grant.mode,
    owner: grant.ownerPrincipalId,
    purpose: quotedPurpose(grant.purpose),
    requester: ctx.requesterPrincipalId,
    resource: grant.resource,
    scopeDigest: composedScopeDigest(request),
    tier: grant.tier,
    verb: grant.verb,
  });
  const result = await transport(request, grant, owner);
  if (roomNotice !== undefined) {
    try {
      await roomNotice(disclosure, grant);
    } catch {
    }
  }
  return { disclosure, ok: true, result };
}

export function composedScopeDigest(request: GrantedRequest): string {
  const queryKeys = Object.keys(request.query ?? {}).sort().join(",");
  let host = "unparseable";
  let path = "";
  try {
    const url = new URL(request.url);
    host = url.host;
    path = url.pathname
      .split("/")
      .map((segment) => (segment.length === 0 || /^(?:[a-z][a-z-]*|v\d+)$/u.test(segment) ? segment : "<id>"))
      .join("/");
  } catch {
  }
  return `${request.method} ${host}${path}${queryKeys.length > 0 ? `?${queryKeys}` : ""}`;
}
