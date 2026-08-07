import { principalKey } from "./principal-key.js";

export const SHARED_VAULT_SUBJECT_PREFIX = "ls:";

export const RAW_VAULT_SUBJECT_PREFIX = "p:";

export function sharedVaultSubject(org: string, linkSetId: string): string {
  return `${SHARED_VAULT_SUBJECT_PREFIX}${org}/${linkSetId}`;
}

export function rawVaultSubject(org: string, platform: string, nativeId: string): string {
  return `${RAW_VAULT_SUBJECT_PREFIX}${org}/${principalKey(platform, nativeId)}`;
}
