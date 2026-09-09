import { randomUUID } from "node:crypto";
import { getOperationalStore } from "../operational/provider.js";
import { appendAudit } from "../audit/audit.js";
import { auditErrorDetail } from "../audit/tool-action.js";
import { tryPrincipalKey } from "./principal-key.js";
import { surfaceIdsFromAccounts, type PrincipalAccountRef } from "./principals.js";
import { linkTenantOf } from "./link-tenant.js";
import { hashLinkCode, mintLinkCode, LINK_CHALLENGE_TTL_MS } from "./link-challenge.js";
import type { LinkTransport } from "./link-flow.js";
import { rawVaultSubject, sharedVaultSubject } from "./oauth-vault-share.js";
import { purgeSubjectCredentials, purgeSubjectsCredentials, type CredentialPurgeOutcome } from "../credentials/purge.js";
import { directoryLinkSetVaultArmed } from "../connections/connector-flags.js";
import type { LinkChallengeRow, LinkChallengeStatus, LinkSetRow, LinkSetStatus, LinkedIdRow, LinkedIdStatus } from "../operational/store.js";
import type { LinkSetPrincipal } from "./link-resolve.js";

export type { LinkChallengeRow, LinkChallengeStatus, LinkSetRow, LinkSetStatus, LinkedIdRow, LinkedIdStatus };

export type LinkEvidence =
  | { readonly kind: "challenge"; readonly challengeId: string }
  | { readonly kind: "config-import"; readonly note: string }
  | {
      readonly kind: "directory-sync";
      readonly provider: string;
      readonly grade: string;
      readonly externalId?: string;
    };

function evidenceLabel(e: LinkEvidence): string {
  switch (e.kind) {
    case "challenge":
      return `challenge:${e.challengeId}`;
    case "config-import":
      return "config-import";
    case "directory-sync":
      return `directory-sync:${e.provider}`;
  }
}

export type LinkWriteResult =
  | { readonly ok: true; readonly linkSetId: string; readonly note: string }
  | { readonly ok: false; readonly reason: string };

export interface LinkedAccount {
  readonly platform: string;
  readonly tenant: string;
  readonly nativeId: string;
}

function accountLabel(platform: string, tenant: string | undefined, nativeId: string): string {
  const key = tryPrincipalKey(platform, tenant, nativeId);
  return key ?? `the ${platform} account "${nativeId}" (workspace unnamed — pre-OPE-309 row)`;
}

function accountVaultSubject(org: string, account: { readonly platform: string; readonly tenant: string; readonly nativeId: string }): string | undefined {
  if (tryPrincipalKey(account.platform, account.tenant, account.nativeId) === undefined) return undefined;
  return rawVaultSubject(org, account.platform, account.tenant, account.nativeId);
}

export async function resolveLinkSet(org: string, platform: string, nativeId: string, tenant?: string | null): Promise<LinkSetRow | null> {
  const store = getOperationalStore();
  const row = await store.getLinkedId(org, platform, linkTenantOf(platform, tenant), nativeId);
  if (!row || row.status !== "confirmed") return null;
  const set = await store.getLinkSet(org, row.linkSetId);
  return set && set.status === "active" ? set : null;
}

export async function expandLinkSet(org: string, linkSetId: string): Promise<readonly LinkedAccount[]> {
  const store = getOperationalStore();
  const set = await store.getLinkSet(org, linkSetId);
  if (!set || set.status !== "active") return [];
  const rows = await store.listLinkedIds(org, linkSetId);
  return rows.filter((r) => r.status === "confirmed").map((r) => ({ platform: r.platform, tenant: r.tenant, nativeId: r.nativeId }));
}

export async function confirmedLinkSetPrincipals(org: string): Promise<readonly LinkSetPrincipal[]> {
  const store = getOperationalStore();
  const sets = await store.listLinkSets(org);
  const rows = await store.listLinkedIds(org);
  const out: LinkSetPrincipal[] = [];
  for (const set of sets) {
    if (set.status !== "active") continue;
    const accounts: PrincipalAccountRef[] = [];
    for (const r of rows) {
      if (r.linkSetId !== set.id || r.status !== "confirmed") continue;
      accounts.push(r.tenant ? { platform: r.platform, tenant: r.tenant, id: r.nativeId } : { platform: r.platform, id: r.nativeId });
    }
    if (accounts.length === 0) continue;
    out.push({ linkSetId: set.id, handle: set.handle, ids: surfaceIdsFromAccounts(accounts) });
  }
  return out;
}

export async function listLinkSetsWithIds(org: string): Promise<readonly { readonly set: LinkSetRow; readonly ids: readonly LinkedIdRow[] }[]> {
  const store = getOperationalStore();
  const sets = await store.listLinkSets(org);
  const all = await store.listLinkedIds(org);
  return sets.map((set) => ({ set, ids: all.filter((r) => r.linkSetId === set.id) }));
}

export interface IssuedChallenge {
  readonly challenge: LinkChallengeRow;
  readonly code?: string;
}

export async function issueLinkChallenge(input: {
  readonly org: string;
  readonly platform: string;
  readonly transport?: LinkTransport;
  readonly target?: LinkedAccount;
  readonly tenant?: string;
  readonly nativeId: string;
  readonly surfaceKey: string;
  readonly now?: Date;
}): Promise<IssuedChallenge> {
  const store = getOperationalStore();
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  await store.expireLinkChallenges(input.org, nowIso);

  const transport: LinkTransport = input.transport ?? "code";
  if (transport === "directory" && !input.target) throw new Error("issueLinkChallenge: the directory transport must name its target account.");
  if (transport === "code" && input.target) throw new Error("issueLinkChallenge: the code transport has no target until something claims it.");
  const code = transport === "code" ? mintLinkCode() : undefined;
  const challenge: LinkChallengeRow = {
    org: input.org,
    id: randomUUID(),
    nonceHash: hashLinkCode(code ?? randomUUID()),
    initiatingPlatform: input.platform,
    initiatingTenant: linkTenantOf(input.platform, input.tenant),
    initiatingNativeId: input.nativeId,
    initiatingSurfaceKey: input.surfaceKey,
    transport,
    ...(input.target
      ? { targetPlatform: input.target.platform, targetTenant: input.target.tenant, targetNativeId: input.target.nativeId }
      : {}),
    status: "pending",
    createdAt: nowIso,
    expiresAt: new Date(now.getTime() + LINK_CHALLENGE_TTL_MS).toISOString(),
  };
  await store.addLinkChallenge(input.org, challenge);
  await auditLink(input.org, input.platform, input.surfaceKey, accountLabel(input.platform, challenge.initiatingTenant, input.nativeId), "identity.link.challenge_issued", {
    challengeId: challenge.id,
    transport,
    ...(input.target ? { target: accountLabel(input.target.platform, input.target.tenant, input.target.nativeId) } : {}),
    expiresAt: challenge.expiresAt,
  });
  return { challenge, ...(code ? { code } : {}) };
}

export async function consentLinkChallenge(input: {
  readonly org: string;
  readonly challengeId: string;
  readonly consenter: LinkedAccount;
  readonly backCode?: string;
  readonly now?: Date;
}): Promise<LinkChallengeRow | null> {
  const store = getOperationalStore();
  const nowIso = (input.now ?? new Date()).toISOString();
  const consented = await store.consentLinkChallenge(
    input.org,
    input.challengeId,
    input.consenter,
    nowIso,
    input.backCode ? hashLinkCode(input.backCode) : undefined,
  );
  if (!consented) return null;
  await auditLink(
    input.org,
    input.consenter.platform,
    consented.initiatingSurfaceKey,
    accountLabel(input.consenter.platform, input.consenter.tenant, input.consenter.nativeId),
    "identity.link.consented",
    {
      challengeId: consented.id,
      initiator: accountLabel(consented.initiatingPlatform, consented.initiatingTenant, consented.initiatingNativeId),
      codeBack: input.backCode !== undefined,
    },
  );
  return consented;
}

export async function auditLinkCodeBackUndeliverable(input: { readonly org: string; readonly challenge: LinkChallengeRow; readonly claimantPlatform: string }): Promise<void> {
  const c = input.challenge;
  await auditLink(input.org, c.initiatingPlatform, c.initiatingSurfaceKey, accountLabel(c.initiatingPlatform, c.initiatingTenant, c.initiatingNativeId), "identity.link.code_back_undeliverable", {
    challengeId: c.id,
    claimantPlatform: input.claimantPlatform,
    reason: `no way to post the second code back to "${input.claimantPlatform}" — the finalize degrades to an acknowledged confirm`,
  });
}

export async function claimLinkChallenge(input: {
  readonly org: string;
  readonly code: string;
  readonly claimant: LinkedAccount;
  readonly backCode?: string;
  readonly now?: Date;
}): Promise<LinkChallengeRow | null> {
  const store = getOperationalStore();
  const nowIso = (input.now ?? new Date()).toISOString();
  const claimed = await store.claimLinkChallenge(
    input.org,
    hashLinkCode(input.code),
    input.claimant.platform,
    input.claimant.tenant,
    input.claimant.nativeId,
    nowIso,
    input.backCode ? hashLinkCode(input.backCode) : undefined,
  );
  if (!claimed) return null;
  await auditLink(input.org, input.claimant.platform, claimed.initiatingSurfaceKey, accountLabel(input.claimant.platform, input.claimant.tenant, input.claimant.nativeId), "identity.link.challenge_claimed", {
    challengeId: claimed.id,
    initiator: accountLabel(claimed.initiatingPlatform, claimed.initiatingTenant, claimed.initiatingNativeId),
  });
  return claimed;
}

export async function auditLinkNoticeUndeliverable(input: { readonly org: string; readonly challenge: LinkChallengeRow; readonly error: unknown }): Promise<void> {
  const c = input.challenge;
  await auditLink(input.org, c.initiatingPlatform, c.initiatingSurfaceKey, accountLabel(c.initiatingPlatform, c.initiatingTenant, c.initiatingNativeId), "identity.link.notice_undeliverable", {
    challengeId: c.id,
    platform: c.initiatingPlatform,
    ...auditErrorDetail(input.error),
  });
}

export async function denyLinkChallenge(input: {
  readonly org: string;
  readonly challengeId: string;
  readonly from?: readonly LinkChallengeStatus[];
  readonly now?: Date;
}): Promise<boolean> {
  const store = getOperationalStore();
  const nowIso = (input.now ?? new Date()).toISOString();
  const challenge = await store.getLinkChallenge(input.org, input.challengeId);
  if (!challenge) return false;
  const decided = await store.decideLinkChallenge(input.org, input.challengeId, input.from ?? ["claimed"], "denied", nowIso);
  if (!decided) return false;
  await auditLink(input.org, challenge.initiatingPlatform, challenge.initiatingSurfaceKey, accountLabel(challenge.initiatingPlatform, challenge.initiatingTenant, challenge.initiatingNativeId), "identity.link.denied", {
    challengeId: challenge.id,
    claimed: challenge.claimedPlatform && challenge.claimedNativeId ? accountLabel(challenge.claimedPlatform, challenge.claimedTenant, challenge.claimedNativeId) : undefined,
  });
  return true;
}

export async function ratifyLinkChallenge(input: {
  readonly org: string;
  readonly challengeId: string;
  readonly handle: string;
  readonly now?: Date;
}): Promise<LinkWriteResult> {
  const store = getOperationalStore();
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();

  const challenge = await store.getLinkChallenge(input.org, input.challengeId);
  if (!challenge) return { ok: false, reason: "that link request no longer exists." };
  if (challenge.status !== "claimed") {
    return { ok: false, reason: `that link request is "${challenge.status}", not awaiting your confirmation — codes are single-use and expire.` };
  }
  if (!challenge.claimedPlatform || !challenge.claimedNativeId || challenge.claimedTenant === undefined) {
    return { ok: false, reason: "that link request has no recorded claimant — refusing to link." };
  }
  const initiator: LinkedAccount = { platform: challenge.initiatingPlatform, tenant: challenge.initiatingTenant, nativeId: challenge.initiatingNativeId };
  const claimed: LinkedAccount = { platform: challenge.claimedPlatform, tenant: challenge.claimedTenant, nativeId: challenge.claimedNativeId };
  if (initiator.platform === claimed.platform && initiator.tenant === claimed.tenant && initiator.nativeId === claimed.nativeId) {
    return { ok: false, reason: "that code was claimed by the SAME account that asked for it — post it from the other account." };
  }

  const existingClaim = await store.getLinkedId(input.org, claimed.platform, claimed.tenant, claimed.nativeId);
  const existingInitiator = await store.getLinkedId(input.org, initiator.platform, initiator.tenant, initiator.nativeId);
  const initiatorConfirmed = existingInitiator?.status === "confirmed";
  const targetSetId = initiatorConfirmed ? existingInitiator!.linkSetId : undefined;
  if (existingClaim && existingClaim.linkSetId !== targetSetId) {
    return { ok: false, reason: `${accountLabel(claimed.platform, claimed.tenant, claimed.nativeId)} already belongs to another person — an account is exactly one person. An admin must revoke that link-set first.` };
  }
  if (existingClaim && existingClaim.status === "revoked") {
    return { ok: false, reason: `${accountLabel(claimed.platform, claimed.tenant, claimed.nativeId)} was revoked — that is terminal. An admin has to sort this out.` };
  }
  if (existingInitiator && existingInitiator.status === "revoked") {
    return { ok: false, reason: "your own account is on a revoked link — that is terminal. An admin has to sort this out." };
  }
  if (targetSetId) {
    const set = await store.getLinkSet(input.org, targetSetId);
    if (set && set.status !== "active") return { ok: false, reason: `your link-set is ${set.status} — an admin has to reactivate it before it can grow.` };
  }

  if (!(await store.decideLinkChallenge(input.org, challenge.id, ["claimed"], "ratified", nowIso))) {
    return { ok: false, reason: "that link request is no longer open — codes are single-use and expire." };
  }

  const evidence: LinkEvidence = { kind: "challenge", challengeId: challenge.id };
  const linkSetId = targetSetId ?? randomUUID();
  if (!targetSetId) {
    await store.putLinkSet(input.org, { org: input.org, id: linkSetId, handle: input.handle, status: "active", createdAt: nowIso, updatedAt: nowIso });
    if (existingInitiator && !initiatorConfirmed) {
      await store.deleteLinkedId(input.org, initiator.platform, initiator.tenant, initiator.nativeId);
    }
  }
  await joinConfirmed(input.org, linkSetId, initiator, evidence, nowIso);
  await joinConfirmed(input.org, linkSetId, claimed, evidence, nowIso);

  await auditLink(input.org, challenge.initiatingPlatform, challenge.initiatingSurfaceKey, accountLabel(initiator.platform, initiator.tenant, initiator.nativeId), "identity.link.confirmed", {
    challengeId: challenge.id,
    linkSetId,
    linked: [accountLabel(initiator.platform, initiator.tenant, initiator.nativeId), accountLabel(claimed.platform, claimed.tenant, claimed.nativeId)],
    evidence: evidenceLabel(evidence),
    ...(await linkSetBlastRadius(input.org, linkSetId)),
  });
  return { ok: true, linkSetId, note: `linked ${accountLabel(claimed.platform, claimed.tenant, claimed.nativeId)} to ${accountLabel(initiator.platform, initiator.tenant, initiator.nativeId)}.` };
}

async function joinConfirmed(org: string, linkSetId: string, account: LinkedAccount, evidence: LinkEvidence, at: string): Promise<void> {
  const store = getOperationalStore();
  const row: LinkedIdRow = {
    org,
    linkSetId,
    platform: account.platform,
    tenant: account.tenant,
    nativeId: account.nativeId,
    status: "confirmed",
    establishedBy: evidenceLabel(evidence),
    evidenceJson: JSON.stringify(evidence),
    createdAt: at,
    updatedAt: at,
  };
  if (await store.insertLinkedId(org, row)) return;
  await store.updateLinkedIdStatus(org, account.platform, account.tenant, account.nativeId, ["suggested", "confirmed"], "confirmed", row.establishedBy, row.evidenceJson, at);
}

export async function ensureLinkSet(input: {
  readonly org: string;
  readonly linkSetId: string;
  readonly handle: string;
  readonly now?: Date;
}): Promise<{ readonly set: LinkSetRow; readonly created: boolean }> {
  const store = getOperationalStore();
  const existing = await store.getLinkSet(input.org, input.linkSetId);
  if (existing) return { set: existing, created: false };
  const at = (input.now ?? new Date()).toISOString();
  const set: LinkSetRow = { org: input.org, id: input.linkSetId, handle: input.handle, status: "active", createdAt: at, updatedAt: at };
  await store.putLinkSet(input.org, set);
  await auditLink(input.org, "directory", undefined, input.linkSetId, "identity.link.set_created", { linkSetId: input.linkSetId, handle: input.handle });
  return { set, created: true };
}

export async function suggestLinkedId(input: {
  readonly org: string;
  readonly linkSetId: string;
  readonly account: LinkedAccount;
  readonly evidence: LinkEvidence;
  readonly now?: Date;
}): Promise<LinkWriteResult> {
  const store = getOperationalStore();
  const at = (input.now ?? new Date()).toISOString();
  const set = await store.getLinkSet(input.org, input.linkSetId);
  if (!set) return { ok: false, reason: `no link-set "${input.linkSetId}".` };
  if (set.status !== "active") return { ok: false, reason: `link-set "${input.linkSetId}" is ${set.status}.` };
  const inserted = await store.insertLinkedId(input.org, {
    org: input.org,
    linkSetId: input.linkSetId,
    platform: input.account.platform,
    tenant: input.account.tenant,
    nativeId: input.account.nativeId,
    status: "suggested",
    establishedBy: evidenceLabel(input.evidence),
    evidenceJson: JSON.stringify(input.evidence),
    createdAt: at,
    updatedAt: at,
  });
  if (!inserted) return { ok: false, reason: `${accountLabel(input.account.platform, input.account.tenant, input.account.nativeId)} already belongs to a link-set.` };
  await auditLink(input.org, input.account.platform, undefined, accountLabel(input.account.platform, input.account.tenant, input.account.nativeId), "identity.link.suggested", {
    linkSetId: input.linkSetId,
    evidence: evidenceLabel(input.evidence),
  });
  return { ok: true, linkSetId: input.linkSetId, note: `suggested ${accountLabel(input.account.platform, input.account.tenant, input.account.nativeId)}.` };
}

export async function confirmLinkedId(input: {
  readonly org: string;
  readonly account: LinkedAccount;
  readonly evidence: LinkEvidence;
  readonly now?: Date;
}): Promise<LinkWriteResult> {
  const store = getOperationalStore();
  const at = (input.now ?? new Date()).toISOString();
  const row = await store.getLinkedId(input.org, input.account.platform, input.account.tenant, input.account.nativeId);
  if (!row) return { ok: false, reason: `${accountLabel(input.account.platform, input.account.tenant, input.account.nativeId)} is not on any link-set.` };
  if (row.status === "revoked") return { ok: false, reason: "that link was revoked — revocation is terminal." };
  const set = await store.getLinkSet(input.org, row.linkSetId);
  if (!set || set.status !== "active") return { ok: false, reason: `that link-set is ${set?.status ?? "missing"}.` };
  const label = evidenceLabel(input.evidence);
  if (!(await store.updateLinkedIdStatus(input.org, input.account.platform, input.account.tenant, input.account.nativeId, ["suggested", "confirmed"], "confirmed", label, JSON.stringify(input.evidence), at))) {
    return { ok: false, reason: "that link could not be confirmed (it changed underneath this call)." };
  }
  await auditLink(input.org, input.account.platform, undefined, accountLabel(input.account.platform, input.account.tenant, input.account.nativeId), "identity.link.confirmed", {
    linkSetId: row.linkSetId,
    linked: [accountLabel(input.account.platform, input.account.tenant, input.account.nativeId)],
    evidence: label,
    ...(await linkSetBlastRadius(input.org, row.linkSetId)),
  });
  return { ok: true, linkSetId: row.linkSetId, note: `confirmed ${accountLabel(input.account.platform, input.account.tenant, input.account.nativeId)}.` };
}

export async function unlinkOwnId(input: {
  readonly org: string;
  readonly actor: LinkedAccount;
  readonly target?: LinkedAccount;
  readonly now?: Date;
}): Promise<LinkWriteResult> {
  const store = getOperationalStore();
  const at = (input.now ?? new Date()).toISOString();
  const target = input.target ?? input.actor;
  const mine = await store.getLinkedId(input.org, input.actor.platform, input.actor.tenant, input.actor.nativeId);
  if (!mine) return { ok: false, reason: "you have no linked accounts to unlink." };
  if (mine.status === "revoked") return { ok: false, reason: "your link was revoked — revocation is terminal, and an admin has to sort it out." };
  const row = input.target ? await store.getLinkedId(input.org, target.platform, target.tenant, target.nativeId) : mine;
  if (!row || row.linkSetId !== mine.linkSetId) {
    return { ok: false, reason: `${accountLabel(target.platform, target.tenant, target.nativeId)} is not on your link-set — you can only unlink your own accounts.` };
  }
  if (row.status === "revoked") return { ok: false, reason: "that link was revoked — revocation is terminal." };
  if (!(await store.deleteLinkedId(input.org, target.platform, target.tenant, target.nativeId))) {
    return { ok: false, reason: "that link had already gone." };
  }
  const targetSubject = accountVaultSubject(input.org, target);
  const purge = targetSubject ? await purgeSubjectCredentials(targetSubject) : { purged: 0, failed: false };
  await auditLink(input.org, input.actor.platform, undefined, accountLabel(input.actor.platform, input.actor.tenant, input.actor.nativeId), "identity.link.unlinked", {
    linkSetId: row.linkSetId,
    unlinked: accountLabel(target.platform, target.tenant, target.nativeId),
    at,
    credentialsPurged: purge.purged,
    ...(purge.failed ? { purgeFailed: true } : {}),
    ...(await linkSetBlastRadius(input.org, row.linkSetId)),
  });
  return { ok: true, linkSetId: row.linkSetId, note: `unlinked ${accountLabel(target.platform, target.tenant, target.nativeId)}.` };
}

export async function setLinkSetHold(input: {
  readonly org: string;
  readonly linkSetId: string;
  readonly hold: "suspended" | "active";
  readonly actor: string;
  readonly now?: Date;
}): Promise<LinkWriteResult> {
  const store = getOperationalStore();
  const at = (input.now ?? new Date()).toISOString();
  const from: readonly LinkSetStatus[] = input.hold === "suspended" ? ["active"] : ["suspended"];
  if (!(await store.updateLinkSetStatus(input.org, input.linkSetId, from, input.hold, at))) {
    const set = await store.getLinkSet(input.org, input.linkSetId);
    return { ok: false, reason: set ? `link-set "${input.linkSetId}" is ${set.status} — cannot ${input.hold === "suspended" ? "suspend" : "reactivate"} it.` : `no link-set "${input.linkSetId}".` };
  }
  await auditLink(input.org, "control", undefined, input.actor, input.hold === "suspended" ? "identity.link.suspended" : "identity.link.reactivated", { linkSetId: input.linkSetId });
  return { ok: true, linkSetId: input.linkSetId, note: `link-set ${input.linkSetId} is now ${input.hold}.` };
}

export async function revokeLinkSet(input: { readonly org: string; readonly linkSetId: string; readonly actor: string; readonly now?: Date }): Promise<LinkWriteResult> {
  const store = getOperationalStore();
  const at = (input.now ?? new Date()).toISOString();
  if (!(await store.updateLinkSetStatus(input.org, input.linkSetId, ["active", "suspended"], "revoked", at))) {
    const set = await store.getLinkSet(input.org, input.linkSetId);
    return { ok: false, reason: set ? `link-set "${input.linkSetId}" is already revoked.` : `no link-set "${input.linkSetId}".` };
  }
  const tombstoned = await store.revokeLinkedIdsForSet(input.org, input.linkSetId, at);
  const purge = await purgeLinkSetCredentialsBestEffort(input.org, input.linkSetId);
  await auditLink(input.org, "control", undefined, input.actor, "identity.link.revoked", {
    linkSetId: input.linkSetId,
    tombstoned,
    credentialsPurged: purge.purged,
    ...(purge.failed ? { purgeFailed: true } : {}),
  });
  return {
    ok: true,
    linkSetId: input.linkSetId,
    note:
      `revoked link-set ${input.linkSetId} (${tombstoned} account(s) tombstoned, ${purge.purged} credential(s) purged)` +
      (purge.failed ? " — the credential purge FAILED; the revoke stands, re-run purge_link_set_credentials." : "."),
  };
}

async function purgeLinkSetCredentialsBestEffort(org: string, linkSetId: string): Promise<CredentialPurgeOutcome> {
  const rows = await getOperationalStore()
    .listLinkedIds(org, linkSetId)
    .catch(() => [] as readonly LinkedIdRow[]);
  return purgeSubjectsCredentials([
    sharedVaultSubject(org, linkSetId),
    ...rows.map((r) => accountVaultSubject(org, r)).filter((sub): sub is string => sub !== undefined),
  ]);
}

export async function purgeLinkSetCredentials(input: { readonly org: string; readonly linkSetId: string; readonly actor: string }): Promise<LinkWriteResult & { readonly purged?: number }> {
  const store = getOperationalStore();
  const set = await store.getLinkSet(input.org, input.linkSetId);
  if (!set) return { ok: false, reason: `no link-set "${input.linkSetId}".` };
  const purge = await purgeLinkSetCredentialsBestEffort(input.org, input.linkSetId);
  await auditLink(input.org, "control", undefined, input.actor, "identity.link.credentials_purged", {
    linkSetId: input.linkSetId,
    setStatus: set.status,
    credentialsPurged: purge.purged,
    ...(purge.failed ? { purgeFailed: true } : {}),
  });
  if (purge.failed) return { ok: false, reason: `credential purge for link-set "${input.linkSetId}" failed — nothing was destroyed; check the vault/adapter and retry.` };
  return { ok: true, linkSetId: input.linkSetId, purged: purge.purged, note: `purged ${purge.purged} credential(s) for link-set ${input.linkSetId} (set is ${set.status}).` };
}

async function linkSetBlastRadius(org: string, linkSetId: string): Promise<{ memberCount: number; vaultArmed: boolean }> {
  const vaultArmed = directoryLinkSetVaultArmed();
  try {
    return { memberCount: (await expandLinkSet(org, linkSetId)).length, vaultArmed };
  } catch {
    return { memberCount: -1, vaultArmed };
  }
}

async function auditLink(org: string, platform: string, surfaceKey: string | undefined, principalId: string, action: string, detail: Record<string, unknown>): Promise<void> {
  const parts = surfaceKey?.split("/") ?? [];
  await appendAudit({
    org,
    platform,
    workspace: parts[1] ?? platform,
    ...(surfaceKey ? { surface: surfaceKey } : {}),
    principalId,
    action,
    detail,
  });
}
