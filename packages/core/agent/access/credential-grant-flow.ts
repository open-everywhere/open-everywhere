import { randomUUID } from "node:crypto";
import { appendAudit } from "../audit/audit.js";
import { getOperationalStore } from "../operational/provider.js";
import {
  mintBorrowToken,
  ownerHasConnectorConsent,
  readBorrowToolSchema,
  resolveBorrowConnection,
  startOwnerConnectorAuthorization,
  withinBorrowDeadline,
  borrowDeadline,
  type BorrowConnection,
  type GrantBorrowDeps,
} from "../connections/grant-mcp-borrow.js";
import {
  credentialGrantExpiry,
  credentialGrantFromAsk,
  credentialGrantMintVerdict,
  GRANT_ASK_TTL_MS,
  type GrantMintInput,
  type GrantMintRefusal,
} from "./credential-grant.js";
import {
  approveGrantCard,
  declineGrantCard,
  deliverGrantCard,
  deliverGrantConsentPrompt,
  expireGrantCard,
  refuseGrantCard,
  type GrantApproveGate,
  type GrantAskWorkerOrigin,
  type GrantCardDelivery,
} from "./credential-grant-card.js";
import { grantOwnerSubject } from "./credential-grant-owner.js";
import { grantScopeKeyForMode } from "./credential-grant-scope.js";
import { postGrantResolution, type GrantNoticeOutcome } from "./credential-grant-resolution.js";
import { pinFrozenArgsIntoSchema } from "./grant-schema-pin.js";
import {
  grantAuditResource,
  grantBorrowResourceLabel,
  grantFrozenArgsDigest,
  grantToolSlug,
  quotedPurpose,
  type CredentialGrantAskRow,
  type CredentialGrantMode,
  type CredentialGrantRow,
  type GrantJsonObject,
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
  readonly mcpTool: string;
  readonly frozenArgs: GrantJsonObject;
  readonly targetLabel: string;
  readonly scopeKey: string;
  readonly domainScopeKey?: string;
  readonly purpose: string;
  readonly requesterTarget?: string;
  readonly requestedMode: CredentialGrantMode;
  readonly domainGrantsConnector: boolean;
  readonly explicit: boolean;
  readonly workerOrigin?: GrantAskWorkerOrigin;
  readonly conversationLabel?: string;
  readonly nowMs: number;
}

export type AskForGrantOutcome =
  | { readonly sent: true; readonly askId: string; readonly ownerHandle: string; readonly toolName: string }
  | {
      readonly sent: false;
      readonly reason: GrantMintRefusal | "owner_unreachable";
      readonly liveGrant?: { readonly mcpTool: string | undefined; readonly expiresAt: string };
    };

export async function askForCredentialGrant(input: AskForGrantInput): Promise<AskForGrantOutcome> {
  const store = getOperationalStore();
  const nowIso = new Date(input.nowMs).toISOString();
  const askId = randomUUID();
  const toolSlug = grantToolSlug(input.mcpTool) ?? "";
  const resource = grantBorrowResourceLabel(input.targetLabel, input.mcpTool, input.frozenArgs);
  const live = await liveBorrowGrantInReach(input, grantFrozenArgsDigest(input.frozenArgs), nowIso);
  const liveAsk =
    input.requesterPrincipalId === undefined
      ? null
      : await store.liveCredentialGrantAsk(input.org, input.requesterPrincipalId, input.ownerPrincipalId, toolSlug, resource, nowIso);
  const mintInput: GrantMintInput = {
    borrow: {
      mcpTool: input.mcpTool,
      rowId: askId,
      takenToolNames: await takenGrantToolNames(input.org, input.scopeKey, input.domainScopeKey, nowIso),
      targetLabel: input.targetLabel,
    },
    connector: input.connector,
    domainGrantsConnector: input.domainGrantsConnector,
    liveAsk: liveAsk ?? undefined,
    liveGrant: live ?? undefined,
    ownerHandle: input.ownerHandle,
    ownerPrincipalId: input.ownerPrincipalId,
    requesterPrincipalId: input.requesterPrincipalId,
  };
  const verdict = credentialGrantMintVerdict(mintInput);
  const requesterPrincipalId = input.requesterPrincipalId;
  if (!verdict.ok || requesterPrincipalId === undefined) {
    await auditGrant(input, "grant.refused", input.requesterPrincipalId, {
      connector: input.connector,
      gate: verdict.ok ? "unverified_requester" : verdict.reason,
      resource: grantAuditResource({ frozenArgs: input.frozenArgs, mcpTool: input.mcpTool, resource }),
      scopeKey: input.scopeKey,
      ...(input.domainScopeKey === undefined ? {} : { domainScopeKey: input.domainScopeKey }),
      verb: toolSlug,
    });
    return {
      reason: verdict.ok ? "unverified_requester" : verdict.reason,
      sent: false,
      ...(live === null || (verdict.ok ? "unverified_requester" : verdict.reason) !== "grant_already_live"
        ? {}
        : { liveGrant: { expiresAt: live.expiresAt, mcpTool: live.mcpTool } }),
    };
  }
  const ask: CredentialGrantAskRow = {
    connector: input.connector,
    createdAt: nowIso,
    expiresAt: new Date(input.nowMs + GRANT_ASK_TTL_MS).toISOString(),
    frozenArgs: input.frozenArgs,
    id: askId,
    mcpTool: input.mcpTool,
    ownerNativeId: input.ownerNativeId,
    ownerPlatform: input.ownerPlatform,
    ownerPrincipalId: input.ownerPrincipalId,
    ownerSlug: verdict.ownerSlug,
    purpose: input.purpose,
    requestedMode: input.requestedMode,
    requesterPrincipalId,
    ...(input.requesterTarget === undefined ? {} : { requesterTarget: input.requesterTarget }),
    resource,
    scopeKey: input.scopeKey,
    ...(input.domainScopeKey === undefined ? {} : { domainScopeKey: input.domainScopeKey }),
    status: "pending",
    toolName: verdict.toolName,
    verb: toolSlug,
  };
  await store.addCredentialGrantAsk(input.org, ask);
  const delivery: GrantCardDelivery = await deliverGrantCard(ask, input, input.requesterLabel, input.workerOrigin, input.conversationLabel);
  if (!delivery.delivered) {
    await store.decideCredentialGrantAsk(input.org, ask.id, ["pending"], "expired", nowIso);
    await auditGrant(input, "grant.refused", ask.requesterPrincipalId, {
      askId: ask.id,
      connector: ask.connector,
      gate: "owner_unreachable",
      owner: ask.ownerPrincipalId,
      reason: delivery.reason,
      resource: grantAuditResource(ask),
      scopeKey: ask.scopeKey,
      ...(ask.domainScopeKey === undefined ? {} : { domainScopeKey: ask.domainScopeKey }),
      verb: ask.verb,
    });
    return { reason: "owner_unreachable", sent: false };
  }
  try {
    await store.setCredentialGrantAskCard(input.org, ask.id, delivery.surfaceId, delivery.messageId);
  } catch (err) {
    log(`card locus for ask ${ask.id} could not be stamped: ${String(err)}`);
  }
  await auditGrant(input, "grant.asked", ask.requesterPrincipalId, {
    askId: ask.id,
    connector: ask.connector,
    explicit: input.explicit,
    owner: ask.ownerPrincipalId,
    purpose: quotedPurpose(ask.purpose),
    requestedMode: ask.requestedMode,
    resource: grantAuditResource(ask),
    scopeKey: ask.scopeKey,
    ...(ask.domainScopeKey === undefined ? {} : { domainScopeKey: ask.domainScopeKey }),
    toolName: ask.toolName,
    verb: ask.verb,
  });
  return { askId: ask.id, ownerHandle: ask.ownerSlug, sent: true, toolName: verdict.toolName };
}

async function liveBorrowGrantInReach(input: AskForGrantInput, frozenArgsDigest: string, nowIso: string): Promise<CredentialGrantRow | null> {
  const store = getOperationalStore();
  const read = async (scopeKey: string): Promise<CredentialGrantRow | null> =>
    await store.liveBorrowCredentialGrant(input.org, input.ownerPrincipalId, input.connector, input.mcpTool, frozenArgsDigest, scopeKey, nowIso);
  const own = await read(input.scopeKey);
  if (own !== null) return own;
  const domainScopeKey = input.domainScopeKey;
  if (domainScopeKey === undefined || domainScopeKey === input.scopeKey) return null;
  const shared = await read(domainScopeKey);
  return shared !== null && shared.mode === "standing" ? shared : null;
}

async function takenGrantToolNames(org: string, scopeKey: string, domainScopeKey: string | undefined, nowIso: string): Promise<readonly string[]> {
  const store = getOperationalStore();
  const names: string[] = [];
  const claim = (row: { readonly toolName?: string }): void => {
    if (row.toolName !== undefined) names.push(row.toolName);
  };
  for (const row of await store.credentialGrantsForScope(org, scopeKey)) claim(row);
  for (const ask of await store.pendingCredentialGrantAsksForScope(org, scopeKey, nowIso)) claim(ask);
  if (domainScopeKey !== undefined && domainScopeKey !== scopeKey) {
    for (const row of await store.liveStandingCredentialGrantsForScope(org, domainScopeKey, nowIso)) claim(row);
  }
  return names;
}

export type ApproveGrantOutcome =
  | { readonly approved: true; readonly grant: CredentialGrantRow }
  | {
      readonly approved: false;
      readonly reason:
        | "not_pending_or_expired"
        | "mint_refused"
        | "standing_unavailable"
        | "owner_unresolvable"
        | "consent_required"
        | "catalogue_unreachable"
        | GrantApproveGate;
      readonly prompted?: boolean;
    };

const GRANT_CONSENT_LINK_TTL_MS = 60 * 60 * 1000;

export async function approveCredentialGrant(
  stamps: GrantAuditStamps,
  askId: string,
  mode: CredentialGrantMode,
  approverPrincipalId: string,
  nowMs: number,
  standingMs?: number,
  borrowDeps: GrantBorrowDeps = {},
): Promise<ApproveGrantOutcome> {
  const store = getOperationalStore();
  const nowIso = new Date(nowMs).toISOString();
  const grantId = randomUUID();

  const pending = await store.getCredentialGrantAsk(stamps.org, askId);
  if (pending === null || pending.status !== "pending" || pending.expiresAt <= nowIso) return { approved: false, reason: "not_pending_or_expired" };

  if (grantScopeKeyForMode(mode, pending.scopeKey, pending.domainScopeKey) === undefined) return { approved: false, reason: "standing_unavailable" };

  const catalogue = await readApprovedToolSchema(stamps, pending, borrowDeps);
  if (!catalogue.ok) {
    if (catalogue.reason === "tool_absent" || catalogue.reason === "frozen_args_unknown") await closeRefusedAsk(stamps, pending, catalogue.reason, approverPrincipalId, nowIso);
    return catalogue.reason === "consent_required"
      ? { approved: false, prompted: catalogue.prompted, reason: "consent_required" }
      : { approved: false, reason: catalogue.reason };
  }

  const ask = await store.approveCredentialGrantAsk(stamps.org, askId, mode, grantId, nowIso);
  if (ask === null) return { approved: false, reason: "not_pending_or_expired" };
  const verdict = credentialGrantMintVerdict({
    borrow: { mcpTool: ask.mcpTool ?? "", rowId: ask.id, takenToolNames: [], targetLabel: "" },
    connector: ask.connector,
    domainGrantsConnector: true,
    liveAsk: undefined,
    liveGrant: undefined,
    ownerHandle: ask.ownerSlug,
    ownerPrincipalId: ask.ownerPrincipalId,
    requesterPrincipalId: ask.requesterPrincipalId,
  });
  if (!verdict.ok || verdict.ownerSlug !== ask.ownerSlug) return { approved: false, reason: "mint_refused" };
  const grant = credentialGrantFromAsk(ask, {
    expiresAt: credentialGrantExpiry(mode, nowMs, standingMs),
    grantId,
    inputSchema: catalogue.schema,
    mode,
    nowIso,
    ownerSlug: ask.ownerSlug,
    tier: verdict.tier,
  });
  if (grant === undefined) return { approved: false, reason: "mint_refused" };
  await store.addCredentialGrant(stamps.org, grant);
  await auditGrant(stamps, "grant.granted", approverPrincipalId, {
    askId: ask.id,
    connector: grant.connector,
    expiresAt: grant.expiresAt,
    grantId: grant.id,
    mode: grant.mode,
    owner: grant.ownerPrincipalId,
    requester: grant.requesterPrincipalId,
    resource: grantAuditResource(grant),
    scopeKey: grant.scopeKey,
    tier: grant.tier,
    verb: grant.verb,
  });
  await postGrantResolution(ask, { askedMode: pending.requestedMode, grant, kind: "approved" }, nowMs);
  try {
    await approveGrantCard(ask, grant, nowMs);
  } catch (err) {
    log(`ask ${ask.id}: the owner's card could not be rewritten after approval: ${String(err)}`);
  }
  return { approved: true, grant };
}

type ApprovedToolSchema =
  | { readonly ok: true; readonly schema: GrantJsonObject }
  | { readonly ok: false; readonly reason: "consent_required"; readonly prompted: boolean }
  | { readonly ok: false; readonly reason: "owner_unresolvable" | "catalogue_unreachable" | GrantApproveGate };

async function readApprovedToolSchema(stamps: GrantAuditStamps, ask: CredentialGrantAskRow, deps: GrantBorrowDeps): Promise<ApprovedToolSchema> {
  const mcpTool = ask.mcpTool;
  if (mcpTool === undefined) return { ok: false, reason: "tool_absent" };
  const frozenArgs = ask.frozenArgs ?? {};
  const owner = await grantOwnerSubject(stamps.org, ask.connector, ask.ownerPrincipalId);
  if (owner === undefined) return { ok: false, reason: "owner_unresolvable" };

  const deadline = borrowDeadline();

  let conn: BorrowConnection;
  try {
    conn = resolveBorrowConnection(ask.connector, deps);
  } catch (err) {
    log(`ask ${ask.id}: the ${ask.connector} borrow connection could not be resolved: ${String(err)}`);
    return { ok: false, reason: "catalogue_unreachable" };
  }

  const consent = await withinBorrowDeadline(deadline, "the consent probe", async () => await ownerHasConnectorConsent(conn, owner.vaultSubject)).catch(
    () => undefined,
  );
  if (consent === false) {
    let prompted = false;
    try {
      const url = await startOwnerConnectorAuthorization(conn, owner.vaultSubject, GRANT_CONSENT_LINK_TTL_MS);
      prompted = await deliverGrantConsentPrompt(ask, stamps, url);
    } catch (err) {
      log(`ask ${ask.id}: no ${ask.connector} connect link could be minted for the owner: ${String(err)}`);
    }
    return { ok: false, prompted, reason: "consent_required" };
  }

  let entry: Awaited<ReturnType<typeof readBorrowToolSchema>>;
  try {
    const token = await withinBorrowDeadline(deadline, "the owner's token mint", async () => await mintBorrowToken(conn, owner.vaultSubject, deps));
    entry = await readBorrowToolSchema(conn, mcpTool, frozenArgs, token, deps, deadline);
  } catch (err) {
    log(`ask ${ask.id}: the ${ask.connector} tool catalogue could not be read: ${String(err)}`);
    return { ok: false, reason: "catalogue_unreachable" };
  }
  if (!entry.found) {
    log(`ask ${ask.id}: the ${ask.connector} connection publishes no tool the ask names (${String(entry.published.length)} published)`);
    return { ok: false, reason: "tool_absent" };
  }
  const pinned = pinFrozenArgsIntoSchema(entry.inputSchema, frozenArgs);
  if (!pinned.ok) {
    log(`ask ${ask.id}: the ask freezes ${String(pinned.unknownKeys.length)} argument(s) the ${ask.connector} tool does not declare`);
    return { ok: false, reason: "frozen_args_unknown" };
  }
  return { ok: true, schema: pinned.schema };
}

async function closeRefusedAsk(
  stamps: GrantAuditStamps,
  ask: CredentialGrantAskRow,
  gate: GrantApproveGate,
  approverPrincipalId: string,
  nowIso: string,
): Promise<void> {
  const won = await getOperationalStore().decideCredentialGrantAsk(stamps.org, ask.id, ["pending"], "expired", nowIso);
  if (!won) return;
  await auditGrant(stamps, "grant.refused", approverPrincipalId, {
    askId: ask.id,
    connector: ask.connector,
    gate,
    owner: ask.ownerPrincipalId,
    resource: grantAuditResource(ask),
    verb: ask.verb,
  });
  await postGrantResolution(ask, { gate, kind: "refused" }, Date.parse(nowIso));
  try {
    await refuseGrantCard(ask, gate);
  } catch (err) {
    log(`ask ${ask.id}: the owner's card could not be rewritten after a ${gate} refusal: ${String(err)}`);
  }
}

function log(line: string): void {
  console.log(`[open-everywhere:grant] ${line}`);
}

export async function declineCredentialGrant(stamps: GrantAuditStamps, askId: string, declinerPrincipalId: string, nowMs: number): Promise<boolean> {
  const store = getOperationalStore();
  const nowIso = new Date(nowMs).toISOString();
  const decided = await store.decideCredentialGrantAsk(stamps.org, askId, ["pending"], "declined", nowIso);
  if (!decided) return false;
  await auditGrant(stamps, "grant.declined", declinerPrincipalId, { askId, reason: "declined" });
  const ask = await store.getCredentialGrantAsk(stamps.org, askId);
  if (ask !== null) {
    await postGrantResolution(ask, { kind: "declined" }, nowMs);
    try {
      await declineGrantCard(ask);
    } catch (err) {
      log(`ask ${askId}: the owner's card could not be rewritten after decline: ${String(err)}`);
    }
  }
  return true;
}

export async function revokeCredentialGrant(
  stamps: GrantAuditStamps,
  grantId: string,
  revokerPrincipalId: string,
  route: "thread" | "card" | "vault" | "cascade" | "home",
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
      const notice: GrantSweepNotice = fresh ? await postGrantResolution(ask, { kind: "expired" }, Date.parse(nowIso)) : "withheld_stale";
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
        resource: grantAuditResource(ask),
        verb: ask.verb,
      });
    } catch (err) {
      log(`sweep: ask ${ask.id} could not be expired: ${String(err)}`);
    }
  }
  return { asks, cardsUpdated, grants: await store.expireCredentialGrants(org, nowIso), requesterNotices };
}

const GRANT_LAPSE_NOTICE_MAX_AGE_MS = 48 * 60 * 60 * 1000;

type GrantSweepNotice = GrantNoticeOutcome | "withheld_stale";

export interface GrantSweepReport {
  readonly asks: number;
  readonly grants: number;
  readonly requesterNotices: number;
  readonly cardsUpdated: number;
}

export async function auditGrant(
  stamps: GrantAuditStamps,
  action:
    | "grant.asked"
    | "grant.granted"
    | "grant.declined"
    | "grant.expired"
    | "grant.used"
    | "grant.refused"
    | "grant.revoked"
    | "grant.notified"
    | "grant.undisclosed"
    | "grant.mount_refused"
    | "grant.mount_withheld",
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
