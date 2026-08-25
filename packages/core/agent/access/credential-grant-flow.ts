import { randomUUID } from "node:crypto";
import { appendAudit } from "../audit/audit.js";
import { getOperationalStore } from "../operational/provider.js";
import {
  credentialGrantExpiry,
  credentialGrantFromAsk,
  credentialGrantMintVerdict,
  grantableVerb,
  GRANT_ASK_TTL_MS,
  type GrantMintInput,
  type GrantMintRefusal,
} from "./credential-grant.js";
import { deliverGrantCard, expireGrantCard, type GrantCardDelivery } from "./credential-grant-card.js";
import { postGrantResolution, type GrantNoticeOutcome } from "./credential-grant-resolution.js";
import {
  quotedPurpose,
  type CredentialGrantAskRow,
  type CredentialGrantMode,
  type CredentialGrantRow,
} from "../operational/credential-grant-rows.js";

export interface GrantAuditStamps {
  readonly org: string;
  readonly platform: string;
  readonly workspace: string;
  readonly surface?: string;
}

export interface AskForGrantInput extends GrantAuditStamps {
  readonly requesterPrincipalId: string | undefined;
  readonly requesterLabel: string;
  readonly ownerPrincipalId: string;
  readonly ownerPlatform: string;
  readonly ownerNativeId: string;
  readonly ownerHandle: string;
  readonly connector: string;
  readonly verb: string;
  readonly resource: string;
  readonly scopeKey: string;
  readonly purpose: string;
  readonly requesterTarget?: string;
  readonly requestedMode: CredentialGrantMode;
  readonly domainGrantsConnector: boolean;
  readonly nowMs: number;
}

export type AskForGrantOutcome =
  | { readonly sent: true; readonly askId: string; readonly ownerHandle: string }
  | { readonly sent: false; readonly reason: GrantMintRefusal | "owner_unreachable" };

export async function askForCredentialGrant(input: AskForGrantInput): Promise<AskForGrantOutcome> {
  const store = getOperationalStore();
  const nowIso = new Date(input.nowMs).toISOString();
  const live = await store.liveCredentialGrant(input.org, input.ownerPrincipalId, input.verb, input.scopeKey, nowIso);
  const liveAsk =
    input.requesterPrincipalId === undefined
      ? null
      : await store.liveCredentialGrantAsk(input.org, input.requesterPrincipalId, input.ownerPrincipalId, input.verb, input.resource, nowIso);
  const mintInput: GrantMintInput = {
    connector: input.connector,
    domainGrantsConnector: input.domainGrantsConnector,
    liveAsk: liveAsk ?? undefined,
    liveGrant: live ?? undefined,
    ownerHandle: input.ownerHandle,
    ownerPrincipalId: input.ownerPrincipalId,
    requesterPrincipalId: input.requesterPrincipalId,
    resource: input.resource,
    verb: input.verb,
  };
  const verdict = credentialGrantMintVerdict(mintInput);
  const requesterPrincipalId = input.requesterPrincipalId;
  if (!verdict.ok || requesterPrincipalId === undefined) {
    await auditGrant(input, "grant.refused", input.requesterPrincipalId, {
      connector: input.connector,
      gate: verdict.ok ? "unverified_requester" : verdict.reason,
      resource: input.resource,
      verb: input.verb,
    });
    return { reason: verdict.ok ? "unverified_requester" : verdict.reason, sent: false };
  }
  const ask: CredentialGrantAskRow = {
    connector: input.connector,
    createdAt: nowIso,
    expiresAt: new Date(input.nowMs + GRANT_ASK_TTL_MS).toISOString(),
    id: randomUUID(),
    ownerNativeId: input.ownerNativeId,
    ownerPlatform: input.ownerPlatform,
    ownerPrincipalId: input.ownerPrincipalId,
    ownerSlug: verdict.ownerSlug,
    purpose: input.purpose,
    requestedMode: input.requestedMode,
    requesterPrincipalId,
    ...(input.requesterTarget === undefined ? {} : { requesterTarget: input.requesterTarget }),
    resource: input.resource,
    scopeKey: input.scopeKey,
    status: "pending",
    verb: input.verb,
  };
  await store.addCredentialGrantAsk(input.org, ask);
  const delivery: GrantCardDelivery = await deliverGrantCard(ask, input.requesterLabel);
  if (!delivery.delivered) {
    await store.decideCredentialGrantAsk(input.org, ask.id, ["pending"], "expired", nowIso);
    await auditGrant(input, "grant.refused", ask.requesterPrincipalId, {
      askId: ask.id,
      connector: ask.connector,
      gate: "owner_unreachable",
      reason: delivery.reason,
      verb: ask.verb,
    });
    return { reason: "owner_unreachable", sent: false };
  }
  try {
    await store.setCredentialGrantAskCard(input.org, ask.id, delivery.surfaceId, delivery.messageId);
  } catch (err) {
    console.log(`[open-everywhere:grant] card locus for ask ${ask.id} could not be stamped: ${String(err)}`);
  }
  await auditGrant(input, "grant.asked", ask.requesterPrincipalId, {
    askId: ask.id,
    connector: ask.connector,
    owner: ask.ownerPrincipalId,
    purpose: quotedPurpose(ask.purpose),
    requestedMode: ask.requestedMode,
    resource: ask.resource,
    scopeKey: ask.scopeKey,
    verb: ask.verb,
  });
  return { askId: ask.id, ownerHandle: ask.ownerSlug, sent: true };
}

export type ApproveGrantOutcome =
  | { readonly approved: true; readonly grant: CredentialGrantRow }
  | { readonly approved: false; readonly reason: "not_pending_or_expired" | "verb_unregistered" | "mint_refused" };

export async function approveCredentialGrant(
  stamps: GrantAuditStamps,
  askId: string,
  mode: CredentialGrantMode,
  approverPrincipalId: string,
  nowMs: number,
  standingMs?: number,
): Promise<ApproveGrantOutcome> {
  const store = getOperationalStore();
  const nowIso = new Date(nowMs).toISOString();
  const grantId = randomUUID();
  const ask = await store.approveCredentialGrantAsk(stamps.org, askId, mode, grantId, nowIso);
  if (ask === null) return { approved: false, reason: "not_pending_or_expired" };
  const definition = grantableVerb(ask.verb);
  if (definition === undefined) return { approved: false, reason: "verb_unregistered" };
  const verdict = credentialGrantMintVerdict({
    connector: ask.connector,
    domainGrantsConnector: true,
    liveAsk: undefined,
    liveGrant: undefined,
    ownerHandle: ask.ownerSlug,
    ownerPrincipalId: ask.ownerPrincipalId,
    requesterPrincipalId: ask.requesterPrincipalId,
    resource: ask.resource,
    verb: ask.verb,
  });
  if (!verdict.ok || verdict.ownerSlug !== ask.ownerSlug) return { approved: false, reason: "mint_refused" };
  const grant = credentialGrantFromAsk(ask, {
    expiresAt: credentialGrantExpiry(mode, nowMs, standingMs),
    grantId,
    mode,
    nowIso,
    ownerSlug: ask.ownerSlug,
    tier: definition.tier,
  });
  await store.addCredentialGrant(stamps.org, grant);
  await auditGrant(stamps, "grant.granted", approverPrincipalId, {
    askId: ask.id,
    connector: grant.connector,
    expiresAt: grant.expiresAt,
    grantId: grant.id,
    mode: grant.mode,
    owner: grant.ownerPrincipalId,
    requester: grant.requesterPrincipalId,
    resource: grant.resource,
    scopeKey: grant.scopeKey,
    tier: grant.tier,
    verb: grant.verb,
  });
  await postGrantResolution(ask, { grant, kind: "approved" });
  return { approved: true, grant };
}

export async function declineCredentialGrant(stamps: GrantAuditStamps, askId: string, declinerPrincipalId: string, nowMs: number): Promise<boolean> {
  const store = getOperationalStore();
  const nowIso = new Date(nowMs).toISOString();
  const decided = await store.decideCredentialGrantAsk(stamps.org, askId, ["pending"], "declined", nowIso);
  if (!decided) return false;
  await auditGrant(stamps, "grant.declined", declinerPrincipalId, { askId, reason: "declined" });
  const ask = await store.getCredentialGrantAsk(stamps.org, askId);
  if (ask !== null) await postGrantResolution(ask, { kind: "declined" });
  return true;
}

export async function revokeCredentialGrant(
  stamps: GrantAuditStamps,
  grantId: string,
  revokerPrincipalId: string,
  route: "thread" | "card" | "vault" | "cascade",
  nowMs: number,
): Promise<boolean> {
  const store = getOperationalStore();
  const revoked = await store.revokeCredentialGrant(stamps.org, grantId, new Date(nowMs).toISOString());
  if (revoked) await auditGrant(stamps, "grant.revoked", revokerPrincipalId, { grantId, route });
  return revoked;
}

export async function sweepCredentialGrants(org: string, nowIso: string): Promise<GrantSweepReport> {
  const store = getOperationalStore();
  let asks = 0;
  let requesterNotices = 0;
  let cardsUpdated = 0;
  const staleBefore = new Date(Date.parse(nowIso) - GRANT_LAPSE_NOTICE_MAX_AGE_MS).toISOString();
  for (const ask of await store.listExpiredCredentialGrantAsks(org, nowIso)) {
    try {
      const won = await store.decideCredentialGrantAsk(org, ask.id, ["pending"], "expired", nowIso);
      if (!won) continue;
      asks++;
      const fresh = ask.expiresAt > staleBefore;
      const notice: GrantSweepNotice = fresh ? await postGrantResolution(ask, { kind: "expired" }) : "withheld_stale";
      if (notice === "sent") requesterNotices++;
      const cardUpdated = fresh && (await expireGrantCard(ask, notice === "sent"));
      if (cardUpdated) cardsUpdated++;
      await auditGrant({ org, platform: "grant", workspace: "sweep" }, "grant.expired", ask.requesterPrincipalId, {
        askId: ask.id,
        cardUpdated,
        cause: "ttl",
        connector: ask.connector,
        notice,
        owner: ask.ownerPrincipalId,
        resource: ask.resource,
        verb: ask.verb,
      });
    } catch (err) {
      console.log(`[open-everywhere:grant] sweep: ask ${ask.id} could not be expired: ${String(err)}`);
    }
  }
  return { asks, cardsUpdated, grants: await store.expireCredentialGrants(org, nowIso), requesterNotices };
}

export const GRANT_LAPSE_NOTICE_MAX_AGE_MS = 48 * 60 * 60 * 1000;

export type GrantSweepNotice = GrantNoticeOutcome | "withheld_stale";

export interface GrantSweepReport {
  readonly asks: number;
  readonly grants: number;
  readonly requesterNotices: number;
  readonly cardsUpdated: number;
}

export async function auditGrant(
  stamps: GrantAuditStamps,
  action: "grant.asked" | "grant.granted" | "grant.declined" | "grant.expired" | "grant.used" | "grant.refused" | "grant.revoked",
  principalId: string | undefined,
  detail: Readonly<Record<string, unknown>>,
): Promise<void> {
  await appendAudit({
    action,
    detail,
    org: stamps.org,
    platform: stamps.platform,
    ...(principalId === undefined ? {} : { principalId }),
    ...(stamps.surface === undefined ? {} : { surface: stamps.surface }),
    workspace: stamps.workspace,
  });
}
