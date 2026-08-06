import { getOperationalStore } from "../operational/provider.js";
import { appendAudit } from "../audit/audit.js";
import { principalKey } from "./principal-key.js";
import { resolveLinkSet } from "./link-store.js";
import type { LinkWriteResult, LinkedAccount } from "./link-store.js";

export const SHARED_VAULT_SUBJECT_PREFIX = "ls:";

export function sharedVaultSubject(org: string, linkSetId: string): string {
  return `${SHARED_VAULT_SUBJECT_PREFIX}${org}/${linkSetId}`;
}

export async function hasRatifiedShare(
  org: string,
  linkSetId: string,
  connector: string,
  platform: string,
  nativeId: string,
): Promise<boolean> {
  try {
    return (await getOperationalStore().getOauthVaultGrant(org, linkSetId, connector, platform, nativeId)) !== null;
  } catch {
    return false;
  }
}

export async function ratifyOauthVaultShare(input: {
  readonly org: string;
  readonly connector: string;
  readonly actor: LinkedAccount;
  readonly now?: Date;
}): Promise<LinkWriteResult> {
  const store = getOperationalStore();
  const at = (input.now ?? new Date()).toISOString();
  const set = await resolveLinkSet(input.org, input.actor.platform, input.actor.nativeId);
  if (!set) {
    return {
      ok: false,
      reason: `${principalKey(input.actor.platform, input.actor.nativeId)} is not a confirmed member of an active link-set — link your accounts first, then share.`,
    };
  }
  await store.putOauthVaultGrant(input.org, {
    org: input.org,
    linkSetId: set.id,
    connector: input.connector,
    platform: input.actor.platform,
    nativeId: input.actor.nativeId,
    establishedAt: at,
  });
  await auditVault(input.org, input.actor.platform, principalKey(input.actor.platform, input.actor.nativeId), "identity.oauth_vault.share_ratified", {
    linkSetId: set.id,
    connector: input.connector,
  });
  return { ok: true, linkSetId: set.id, note: `shared ${input.connector} across ${set.handle}'s linked accounts from ${principalKey(input.actor.platform, input.actor.nativeId)}.` };
}

export async function unshareOauthVault(input: {
  readonly org: string;
  readonly connector: string;
  readonly linkSetId: string;
  readonly actor: LinkedAccount;
}): Promise<LinkWriteResult> {
  const store = getOperationalStore();
  if (!(await store.deleteOauthVaultGrant(input.org, input.linkSetId, input.connector, input.actor.platform, input.actor.nativeId))) {
    return { ok: false, reason: `${principalKey(input.actor.platform, input.actor.nativeId)} was not sharing ${input.connector}.` };
  }
  await auditVault(input.org, input.actor.platform, principalKey(input.actor.platform, input.actor.nativeId), "identity.oauth_vault.share_withdrawn", {
    linkSetId: input.linkSetId,
    connector: input.connector,
  });
  return { ok: true, linkSetId: input.linkSetId, note: `stopped sharing ${input.connector} from ${principalKey(input.actor.platform, input.actor.nativeId)}.` };
}

export async function severOauthVaultGrantsForAccount(org: string, account: LinkedAccount): Promise<number> {
  try {
    const removed = await getOperationalStore().deleteOauthVaultGrantsForAccount(org, account.platform, account.nativeId);
    if (removed > 0) {
      await auditVault(org, account.platform, principalKey(account.platform, account.nativeId), "identity.oauth_vault.severed", { removed });
    }
    return removed;
  } catch {
    return 0;
  }
}

export async function severOauthVaultGrantsForSet(org: string, linkSetId: string): Promise<number> {
  try {
    const removed = await getOperationalStore().deleteOauthVaultGrantsForSet(org, linkSetId);
    if (removed > 0) {
      await auditVault(org, "control", linkSetId, "identity.oauth_vault.set_severed", { linkSetId, removed });
    }
    return removed;
  } catch {
    return 0;
  }
}

async function auditVault(org: string, platform: string, principalId: string, action: string, detail: Record<string, unknown>): Promise<void> {
  await appendAudit({ org, platform, workspace: platform, principalId, action, detail });
}
