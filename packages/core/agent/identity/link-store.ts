import { randomUUID } from "node:crypto";
import { getOperationalStore } from "../operational/provider.js";
import { appendAudit } from "../audit/audit.js";
import { principalKey } from "./principal-key.js";
import { hashLinkCode, mintLinkCode, LINK_CHALLENGE_TTL_MS } from "./link-challenge.js";
import { sharedVaultSubject } from "./oauth-vault-share.js";
import { purgeSubjectCredentials, type CredentialPurgeOutcome } from "../credentials/purge.js";
import { directoryLinkSetVaultArmed } from "../connections/connector-flags.js";
import type { LinkChallengeRow, LinkSetRow, LinkSetStatus, LinkedIdRow, LinkedIdStatus } from "../operational/store.js";
import type { LinkSetPrincipal } from "./link-resolve.js";

export type { LinkChallengeRow, LinkSetRow, LinkSetStatus, LinkedIdRow, LinkedIdStatus };

export type LinkEvidence =
  | { readonly kind: "challenge"; readonly challengeId: string }
  | { readonly kind: "config-import"; readonly note: string }
  | {
      readonly kind: "directory-sync";
      readonly provider: string;
      readonly grade: string;
      readonly externalId?: string;
    };

export function evidenceLabel(e: LinkEvidence): string {
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
  readonly nativeId: string;
}

export async function resolveLinkSet(org: string, platform: string, nativeId: string): Promise<LinkSetRow | null> {
  const store = getOperationalStore();
  const row = await store.getLinkedId(org, platform, nativeId);
  if (!row || row.status !== "confirmed") return null;
  const set = await store.getLinkSet(org, row.linkSetId);
  return set && set.status === "active" ? set : null;
}

export async function expandLinkSet(org: string, linkSetId: string): Promise<readonly LinkedAccount[]> {
  const store = getOperationalStore();
  const set = await store.getLinkSet(org, linkSetId);
  if (!set || set.status !== "active") return [];
  const rows = await store.listLinkedIds(org, linkSetId);
  return rows.filter((r) => r.status === "confirmed").map((r) => ({ platform: r.platform, nativeId: r.nativeId }));
}

export async function confirmedLinkSetPrincipals(org: string): Promise<readonly LinkSetPrincipal[]> {
  const store = getOperationalStore();
  const sets = await store.listLinkSets(org);
  const rows = await store.listLinkedIds(org);
  const out: LinkSetPrincipal[] = [];
  for (const set of sets) {
    if (set.status !== "active") continue;
    const ids: Record<string, string> = {};
    for (const r of rows) {
      if (r.linkSetId !== set.id || r.status !== "confirmed") continue;
      if (ids[r.platform] === undefined) ids[r.platform] = r.nativeId;
    }
    if (Object.keys(ids).length === 0) continue;
    out.push({ linkSetId: set.id, handle: set.handle, ids });
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
  readonly code: string;
}

export async function issueLinkChallenge(input: {
  readonly org: string;
  readonly platform: string;
  readonly nativeId: string;
  readonly surfaceKey: string;
  readonly now?: Date;
}): Promise<IssuedChallenge> {
  const store = getOperationalStore();
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  await store.expireLinkChallenges(input.org, nowIso);

  const code = mintLinkCode();
  const challenge: LinkChallengeRow = {
    org: input.org,
    id: randomUUID(),
    nonceHash: hashLinkCode(code),
    initiatingPlatform: input.platform,
    initiatingNativeId: input.nativeId,
    initiatingSurfaceKey: input.surfaceKey,
    status: "pending",
    createdAt: nowIso,
    expiresAt: new Date(now.getTime() + LINK_CHALLENGE_TTL_MS).toISOString(),
  };
  await store.addLinkChallenge(input.org, challenge);
  await auditLink(input.org, input.platform, input.surfaceKey, principalKey(input.platform, input.nativeId), "identity.link.challenge_issued", {
    challengeId: challenge.id,
    expiresAt: challenge.expiresAt,
  });
  return { challenge, code };
}

export async function claimLinkChallenge(input: {
  readonly org: string;
  readonly code: string;
  readonly claimant: LinkedAccount;
  readonly now?: Date;
}): Promise<LinkChallengeRow | null> {
  const store = getOperationalStore();
  const nowIso = (input.now ?? new Date()).toISOString();
  const claimed = await store.claimLinkChallenge(input.org, hashLinkCode(input.code), input.claimant.platform, input.claimant.nativeId, nowIso);
  if (!claimed) return null;
  await auditLink(input.org, input.claimant.platform, claimed.initiatingSurfaceKey, principalKey(input.claimant.platform, input.claimant.nativeId), "identity.link.challenge_claimed", {
    challengeId: claimed.id,
    initiator: principalKey(claimed.initiatingPlatform, claimed.initiatingNativeId),
  });
  return claimed;
}

export async function denyLinkChallenge(input: { readonly org: string; readonly challengeId: string; readonly now?: Date }): Promise<boolean> {
  const store = getOperationalStore();
  const nowIso = (input.now ?? new Date()).toISOString();
  const challenge = await store.getLinkChallenge(input.org, input.challengeId);
  if (!challenge) return false;
  const decided = await store.decideLinkChallenge(input.org, input.challengeId, ["claimed"], "denied", nowIso);
  if (!decided) return false;
  await auditLink(input.org, challenge.initiatingPlatform, challenge.initiatingSurfaceKey, principalKey(challenge.initiatingPlatform, challenge.initiatingNativeId), "identity.link.denied", {
    challengeId: challenge.id,
    claimed: challenge.claimedPlatform && challenge.claimedNativeId ? principalKey(challenge.claimedPlatform, challenge.claimedNativeId) : undefined,
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
  if (!challenge.claimedPlatform || !challenge.claimedNativeId) {
    return { ok: false, reason: "that link request has no recorded claimant — refusing to link." };
  }
  const initiator: LinkedAccount = { platform: challenge.initiatingPlatform, nativeId: challenge.initiatingNativeId };
  const claimed: LinkedAccount = { platform: challenge.claimedPlatform, nativeId: challenge.claimedNativeId };
  if (initiator.platform === claimed.platform && initiator.nativeId === claimed.nativeId) {
    return { ok: false, reason: "that code was claimed by the SAME account that asked for it — post it from the other account." };
  }

  const existingClaim = await store.getLinkedId(input.org, claimed.platform, claimed.nativeId);
  const existingInitiator = await store.getLinkedId(input.org, initiator.platform, initiator.nativeId);
  const initiatorConfirmed = existingInitiator?.status === "confirmed";
  const targetSetId = initiatorConfirmed ? existingInitiator!.linkSetId : undefined;
  if (existingClaim && existingClaim.linkSetId !== targetSetId) {
    return { ok: false, reason: `${principalKey(claimed.platform, claimed.nativeId)} already belongs to another person — an account is exactly one person. An admin must revoke that link-set first.` };
  }
  if (existingClaim && existingClaim.status === "revoked") {
    return { ok: false, reason: `${principalKey(claimed.platform, claimed.nativeId)} was revoked — that is terminal. An admin has to sort this out.` };
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
      await store.deleteLinkedId(input.org, initiator.platform, initiator.nativeId);
    }
  }
  await joinConfirmed(input.org, linkSetId, initiator, evidence, nowIso);
  await joinConfirmed(input.org, linkSetId, claimed, evidence, nowIso);

  await auditLink(input.org, challenge.initiatingPlatform, challenge.initiatingSurfaceKey, principalKey(initiator.platform, initiator.nativeId), "identity.link.confirmed", {
    challengeId: challenge.id,
    linkSetId,
    linked: [principalKey(initiator.platform, initiator.nativeId), principalKey(claimed.platform, claimed.nativeId)],
    evidence: evidenceLabel(evidence),
    ...(await linkSetBlastRadius(input.org, linkSetId)),
  });
  return { ok: true, linkSetId, note: `linked ${principalKey(claimed.platform, claimed.nativeId)} to ${principalKey(initiator.platform, initiator.nativeId)}.` };
}

async function joinConfirmed(org: string, linkSetId: string, account: LinkedAccount, evidence: LinkEvidence, at: string): Promise<void> {
  const store = getOperationalStore();
  const row: LinkedIdRow = {
    org,
    linkSetId,
    platform: account.platform,
    nativeId: account.nativeId,
    status: "confirmed",
    establishedBy: evidenceLabel(evidence),
    evidenceJson: JSON.stringify(evidence),
    createdAt: at,
    updatedAt: at,
  };
  if (await store.insertLinkedId(org, row)) return;
  await store.updateLinkedIdStatus(org, account.platform, account.nativeId, ["suggested", "confirmed"], "confirmed", row.establishedBy, row.evidenceJson, at);
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
    nativeId: input.account.nativeId,
    status: "suggested",
    establishedBy: evidenceLabel(input.evidence),
    evidenceJson: JSON.stringify(input.evidence),
    createdAt: at,
    updatedAt: at,
  });
  if (!inserted) return { ok: false, reason: `${principalKey(input.account.platform, input.account.nativeId)} already belongs to a link-set.` };
  await auditLink(input.org, input.account.platform, undefined, principalKey(input.account.platform, input.account.nativeId), "identity.link.suggested", {
    linkSetId: input.linkSetId,
    evidence: evidenceLabel(input.evidence),
  });
  return { ok: true, linkSetId: input.linkSetId, note: `suggested ${principalKey(input.account.platform, input.account.nativeId)}.` };
}

export async function confirmLinkedId(input: {
  readonly org: string;
  readonly account: LinkedAccount;
  readonly evidence: LinkEvidence;
  readonly now?: Date;
}): Promise<LinkWriteResult> {
  const store = getOperationalStore();
  const at = (input.now ?? new Date()).toISOString();
  const row = await store.getLinkedId(input.org, input.account.platform, input.account.nativeId);
  if (!row) return { ok: false, reason: `${principalKey(input.account.platform, input.account.nativeId)} is not on any link-set.` };
  if (row.status === "revoked") return { ok: false, reason: "that link was revoked — revocation is terminal." };
  const set = await store.getLinkSet(input.org, row.linkSetId);
  if (!set || set.status !== "active") return { ok: false, reason: `that link-set is ${set?.status ?? "missing"}.` };
  const label = evidenceLabel(input.evidence);
  if (!(await store.updateLinkedIdStatus(input.org, input.account.platform, input.account.nativeId, ["suggested", "confirmed"], "confirmed", label, JSON.stringify(input.evidence), at))) {
    return { ok: false, reason: "that link could not be confirmed (it changed underneath this call)." };
  }
  await auditLink(input.org, input.account.platform, undefined, principalKey(input.account.platform, input.account.nativeId), "identity.link.confirmed", {
    linkSetId: row.linkSetId,
    linked: [principalKey(input.account.platform, input.account.nativeId)],
    evidence: label,
    ...(await linkSetBlastRadius(input.org, row.linkSetId)),
  });
  return { ok: true, linkSetId: row.linkSetId, note: `confirmed ${principalKey(input.account.platform, input.account.nativeId)}.` };
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
  const mine = await store.getLinkedId(input.org, input.actor.platform, input.actor.nativeId);
  if (!mine) return { ok: false, reason: "you have no linked accounts to unlink." };
  if (mine.status === "revoked") return { ok: false, reason: "your link was revoked — revocation is terminal, and an admin has to sort it out." };
  const row = input.target ? await store.getLinkedId(input.org, target.platform, target.nativeId) : mine;
  if (!row || row.linkSetId !== mine.linkSetId) {
    return { ok: false, reason: `${principalKey(target.platform, target.nativeId)} is not on your link-set — you can only unlink your own accounts.` };
  }
  if (row.status === "revoked") return { ok: false, reason: "that link was revoked — revocation is terminal." };
  if (!(await store.deleteLinkedId(input.org, target.platform, target.nativeId))) {
    return { ok: false, reason: "that link had already gone." };
  }
  await auditLink(input.org, input.actor.platform, undefined, principalKey(input.actor.platform, input.actor.nativeId), "identity.link.unlinked", {
    linkSetId: row.linkSetId,
    unlinked: principalKey(target.platform, target.nativeId),
    at,
    ...(await linkSetBlastRadius(input.org, row.linkSetId)),
  });
  return { ok: true, linkSetId: row.linkSetId, note: `unlinked ${principalKey(target.platform, target.nativeId)}.` };
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
  return purgeSubjectCredentials(sharedVaultSubject(org, linkSetId));
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
