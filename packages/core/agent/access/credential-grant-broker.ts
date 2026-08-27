import {
  credentialGrantDisclosureLine,
  credentialGrantRefusalMessage,
  credentialGrantStateRefusal,
  grantAuditResource,
  GrantUndispatchedError,
  quotedPurpose,
  type CredentialGrantRefusal,
  type CredentialGrantRow,
} from "../operational/credential-grant-rows.js";
import { getOperationalStore } from "../operational/provider.js";
import { connectorTransportSpec } from "../connections/connector-transport.js";
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

export interface GrantBorrowCall {
  readonly mcpTool: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export type GrantBorrowTransport = (call: GrantBorrowCall, grant: CredentialGrantRow, owner: GrantOwnerSubject) => Promise<unknown>;

const BORROW_TRANSPORTS = new Map<string, GrantBorrowTransport>();

export function registerGrantBorrowTransport(connector: string, transport: GrantBorrowTransport): void {
  BORROW_TRANSPORTS.set(connector, transport);
}

export function grantBorrowTransport(connector: string): GrantBorrowTransport | undefined {
  return BORROW_TRANSPORTS.get(connector);
}

export function _resetGrantBorrowTransportsForTest(): void {
  BORROW_TRANSPORTS.clear();
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

  if (currentJobWakePosture() === "restricted") return refuse("unattended_wake");

  const stateRefusal = credentialGrantStateRefusal(grant, nowIso);
  if (stateRefusal !== undefined) return refuse(stateRefusal);
  if (grant.scopeKey !== ctx.scopeKey) return refuse("out_of_scope");
  if (ctx.requesterPrincipalId === undefined) return refuse("unverified_requester");

  const path = grant.mcpTool === undefined ? resolveVerbPath(grant) : resolveBorrowPath(grant, grant.mcpTool);
  if (path === undefined) return refuse("no_transport");

  const owner = await grantOwnerSubject(ctx.org, grant.connector, grant.ownerPrincipalId);
  if (owner === undefined) return refuse("owner_unresolvable");

  let burnedAt: string | undefined;
  if (grant.mode === "once") {
    const burned = await store.burnCredentialGrant(ctx.org, grant.id, nowIso);
    if (burned === null) return refuse("burned");
    burnedAt = nowIso;
  }

  const send = path.prepare(input);
  const disclosure = credentialGrantDisclosureLine(grant);
  await auditGrant(ctx, "grant.used", ctx.requesterPrincipalId, {
    connector: grant.connector,
    grantId: grant.id,
    mode: grant.mode,
    owner: grant.ownerPrincipalId,
    purpose: quotedPurpose(grant.purpose),
    requester: ctx.requesterPrincipalId,
    resource: grantAuditResource(grant),
    scopeDigest: send.scopeDigest,
    tier: grant.tier,
    verb: grant.verb,
  });
  let result: unknown;
  try {
    result = await send.run(owner);
  } catch (err) {
    if (burnedAt !== undefined && err instanceof GrantUndispatchedError) {
      try {
        const refunded = await store.refundCredentialGrant(ctx.org, grant.id, burnedAt);
        await auditGrant(ctx, "grant.refused", ctx.requesterPrincipalId, {
          connector: grant.connector,
          gate: "undispatched",
          grantId: grant.id,
          mode: grant.mode,
          owner: grant.ownerPrincipalId,
          refunded,
          requester: ctx.requesterPrincipalId,
          resource: grantAuditResource(grant),
          verb: grant.verb,
        });
      } catch (refundErr) {
        console.log(`[open-everywhere:grant] grant ${grant.id}: the undispatched-call refund could not be written: ${String(refundErr)}`);
      }
    }
    throw err;
  }
  if (roomNotice !== undefined) {
    try {
      await roomNotice(disclosure, grant);
    } catch {
    }
  }
  return { disclosure, ok: true, result };
}

interface GrantSendPath {
  prepare(input: Readonly<Record<string, unknown>>): GrantSend;
}

interface GrantSend {
  readonly scopeDigest: string;
  run(owner: GrantOwnerSubject): Promise<unknown>;
}

function resolveVerbPath(grant: CredentialGrantRow): GrantSendPath | undefined {
  const definition = grantableVerb(grant.verb);
  if (definition === undefined) return undefined;
  const transport = grantTransport(grant.connector);
  if (transport === undefined) return undefined;
  return {
    prepare: (input) => {
      const request = definition.compose(grant, input);
      return { run: async (owner) => await transport(request, grant, owner), scopeDigest: composedScopeDigest(request) };
    },
  };
}

function resolveBorrowPath(grant: CredentialGrantRow, mcpTool: string): GrantSendPath | undefined {
  const spec = connectorTransportSpec(grant.connector);
  if (spec === undefined) return undefined;
  const transport = grantBorrowTransport(grant.connector);
  if (transport === undefined) return undefined;
  return {
    prepare: (input) => ({
      run: async (owner) => await transport({ input, mcpTool }, grant, owner),
      scopeDigest: borrowScopeDigest(spec.directUrl, mcpTool, input, grant.frozenArgs ?? {}),
    }),
  };
}

export function borrowScopeDigest(
  directUrl: string,
  mcpTool: string,
  input: Readonly<Record<string, unknown>>,
  frozenArgs: Readonly<Record<string, unknown>>,
): string {
  let host = "unparseable";
  try {
    host = new URL(directUrl).host;
  } catch {
  }
  const keys = [...new Set([...Object.keys(input), ...Object.keys(frozenArgs)])].sort().join(",");
  return `mcp ${host} tools/call ${quotedPurpose(mcpTool)} keys:${keys}`;
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
