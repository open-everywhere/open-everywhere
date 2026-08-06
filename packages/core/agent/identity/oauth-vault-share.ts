export const SHARED_VAULT_SUBJECT_PREFIX = "ls:";

export function sharedVaultSubject(org: string, linkSetId: string): string {
  return `${SHARED_VAULT_SUBJECT_PREFIX}${org}/${linkSetId}`;
}
