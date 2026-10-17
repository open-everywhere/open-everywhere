import { auditErrorDetail } from "../audit/tool-action.js";
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
import { isCredentialGrantConnector } from "./credential-grant.js";
import { auditGrant, type GrantAuditStamps } from "./credential-grant-flow.js";
import {
  GrantBorrowTransportAlreadyRegisteredError,
  grantBorrowTransport,
  registerGrantBorrowTransport,
} from "./grant-borrow-transport-registry.internal.js";
import {
  GrantRoomNoticeAlreadyRegisteredError,
  grantRoomNotice,
  registerGrantRoomNotice,
} from "./grant-room-notice-registry.internal.js";
import { grantOwnerSubject, type GrantOwnerSubject } from "./credential-grant-owner.js";
import { grantScopeAdmits } from "./credential-grant-scope.js";
import { currentJobWakePosture } from "./job-session-state.js";
import { haltScopeFor, resolveHalt, resolveHaltUnaddressed, type HaltScope } from "./halt.js";
import { surfaceKeyOf, tenantKeyOf } from "./resolver.js";

export interface GrantBorrowCall {
  readonly mcpTool: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export type GrantBorrowTransport = (call: GrantBorrowCall, grant: CredentialGrantRow, owner: GrantOwnerSubject) => Promise<unknown>;

export { GrantBorrowTransportAlreadyRegisteredError, grantBorrowTransport, registerGrantBorrowTransport };

export type GrantRoomNotice = (line: string, grant: CredentialGrantRow) => Promise<GrantRoomNoticeOutcome>;

export type GrantRoomNoticeOutcome = { readonly posted: true } | { readonly posted: false; readonly reason: GrantRoomSilence };

export type GrantRoomSilence = "no_room_context" | "no_post_arm" | "post_failed";

export type GrantRoomSilenceAtPort = "port_unarmed" | "arm_threw";

export { GrantRoomNoticeAlreadyRegisteredError, registerGrantRoomNotice };

const REFUND_CAP_PER_TURN = 3;

export const GRANT_REFUND_CAP_PER_TURN = REFUND_CAP_PER_TURN;

export interface GrantCallContext extends GrantAuditStamps {
  readonly scopeKey: string;
  readonly domainScopeKey?: string;
  readonly requesterPrincipalId: string | undefined;
  readonly turnId?: string;
  readonly nowMs: number;
}

export function grantCallHaltScope(ctx: GrantCallContext): HaltScope {
  const roomKey =
    ctx.surface === undefined || ctx.surface === ""
      ? tenantKeyOf({ platform: ctx.platform, workspace: ctx.workspace })
      : surfaceKeyOf({ platform: ctx.platform, workspace: ctx.workspace, channel: ctx.surface });
  return haltScopeFor({
    org: ctx.org,
    scopeKey: roomKey,
    ...(ctx.requesterPrincipalId !== undefined ? { principalKey: ctx.requesterPrincipalId } : {}),
  });
}

const UNRESOLVED_PARTITION = "unknown";

export function grantCallRoomUnresolved(ctx: GrantCallContext): boolean {
  return (
    ctx.org === UNRESOLVED_PARTITION ||
    ctx.platform === UNRESOLVED_PARTITION ||
    ctx.workspace === UNRESOLVED_PARTITION ||
    ctx.surface === undefined ||
    ctx.surface === ""
  );
}

export const HALT_UNRESOLVED_ROOM_NOTE =
  "This deployment could not resolve which conversation this call is running in, so the halt was applied to be safe: a halt anywhere in this organisation stops a call whose room cannot be read.";

export type GrantCallResult =
  | { readonly ok: true; readonly disclosure: string; readonly result: unknown }
  | { readonly ok: false; readonly refused: CredentialGrantRefusal; readonly message: string };

export async function runGrantedCall(grantId: string, input: Readonly<Record<string, unknown>>, ctx: GrantCallContext): Promise<GrantCallResult> {
  const store = getOperationalStore();
  const nowIso = new Date(ctx.nowMs).toISOString();
  const grant = await store.getCredentialGrant(ctx.org, grantId);
  if (grant === null) {
    const shape = { connector: "", mcpTool: undefined, ownerSlug: "the owner", resource: "", verb: "that tool" };
    await auditGrant(ctx, "grant.refused", ctx.requesterPrincipalId, { gate: "revoked", grantId });
    return { message: credentialGrantRefusalMessage(shape, "revoked"), ok: false, refused: "revoked" };
  }
  const refuse = async (reason: CredentialGrantRefusal, note?: string): Promise<GrantCallResult> => {
    await auditGrant(ctx, "grant.refused", ctx.requesterPrincipalId, {
      gate: reason,
      grantId: grant.id,
      owner: grant.ownerPrincipalId,
      verb: grant.verb,
    });
    const message = credentialGrantRefusalMessage(grant, reason);
    return { message: note === undefined ? message : `${message} ${note}`, ok: false, refused: reason };
  };

  if (currentJobWakePosture() === "restricted") return refuse("unattended_wake");

  const roomUnresolved = grantCallRoomUnresolved(ctx);
  const haltState = roomUnresolved ? await resolveHaltUnaddressed(ctx.org) : await resolveHalt(grantCallHaltScope(ctx));
  if (haltState.halted) {
    return refuse("halted", roomUnresolved ? HALT_UNRESOLVED_ROOM_NOTE : undefined);
  }

  const stateRefusal = credentialGrantStateRefusal(grant, nowIso);
  if (stateRefusal !== undefined) return refuse(stateRefusal);
  if (!grantScopeAdmits(grant, ctx.scopeKey, ctx.domainScopeKey)) return refuse("out_of_scope");
  if (ctx.requesterPrincipalId === undefined) return refuse("unverified_requester");

  const mcpTool = grant.mcpTool;
  if (mcpTool === undefined) return refuse("no_lent_tool");

  if (!isCredentialGrantConnector(grant.connector)) return refuse("connector_delisted");

  const path = resolveBorrowPath(grant, mcpTool);
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
  const disclosure = credentialGrantDisclosureLine(grant, ctx.nowMs);
  await auditGrant(ctx, "grant.used", ctx.requesterPrincipalId, {
    connector: grant.connector,
    grantId: grant.id,
    mode: grant.mode,
    owner: grant.ownerPrincipalId,
    purpose: quotedPurpose(grant.purpose),
    requester: ctx.requesterPrincipalId,
    resource: grantAuditResource(grant),
    scopeDigest: send.scopeDigest,
    scopeKey: grant.scopeKey,
    callerScopeKey: ctx.scopeKey,
    tier: grant.tier,
    verb: grant.verb,
  });
  let result: unknown;
  try {
    result = await send.run(owner);
  } catch (err) {
    if (burnedAt !== undefined && err instanceof GrantUndispatchedError) {
      let claimed = false;
      let unclaimable = false;
      try {
        claimed = await store.claimCredentialGrantRefund(ctx.org, grant.id, ctx.turnId, REFUND_CAP_PER_TURN);
      } catch (claimErr) {
        unclaimable = true;
        console.log(`[open-everywhere:grant] grant ${grant.id}: the undispatched-call refund could not be CLAIMED, so the approval stays spent: ${String(claimErr)}`);
      }
      try {
        const refunded = claimed ? await store.refundCredentialGrant(ctx.org, grant.id, burnedAt) : false;
        await auditGrant(ctx, "grant.refused", ctx.requesterPrincipalId, {
          connector: grant.connector,
          gate: claimed ? "undispatched" : unclaimable ? "refund_unclaimed" : "refund_capped",
          grantId: grant.id,
          mode: grant.mode,
          owner: grant.ownerPrincipalId,
          refunded,
          requester: ctx.requesterPrincipalId,
          resource: grantAuditResource(grant),
          verb: grant.verb,
        });
      } catch (refundErr) {
        console.log(
          `[open-everywhere:grant] grant ${grant.id}: the undispatched-call ${claimed ? "refund" : "refund cap row"} could not be written: ${String(refundErr)}`,
        );
      }
    }
    throw err;
  }
  const notice = grantRoomNotice();
  if (notice === undefined) {
    await auditUndisclosedCall(ctx, grant, "port_unarmed");
  } else {
    try {
      const outcome = await notice(disclosure, grant);
      if (!outcome.posted) await auditUndisclosedCall(ctx, grant, outcome.reason);
    } catch (noticeErr) {
      await auditUndisclosedCall(ctx, grant, "arm_threw", noticeErr);
    }
  }
  return { disclosure, ok: true, result };
}

async function auditUndisclosedCall(
  stamps: GrantAuditStamps,
  grant: CredentialGrantRow,
  gate: GrantRoomSilence | GrantRoomSilenceAtPort,
  err?: unknown,
): Promise<void> {
  await auditGrant(stamps, "grant.undisclosed", grant.ownerPrincipalId, {
    connector: grant.connector,
    gate,
    grantId: grant.id,
    mode: grant.mode,
    owner: grant.ownerPrincipalId,
    requester: grant.requesterPrincipalId,
    resource: grantAuditResource(grant),
    verb: grant.verb,
    ...(err === undefined ? {} : { error: auditErrorDetail(err instanceof Error ? err.name : "unknown").error }),
  });
}

interface GrantSendPath {
  prepare(input: Readonly<Record<string, unknown>>): GrantSend;
}

interface GrantSend {
  readonly scopeDigest: string;
  run(owner: GrantOwnerSubject): Promise<unknown>;
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
