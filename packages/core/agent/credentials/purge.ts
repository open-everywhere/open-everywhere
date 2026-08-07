export interface CredentialPurgeHook {
  purgeSubject(subjectId: string): Promise<number>;
}

const registeredHooks = new Map<string, CredentialPurgeHook>();

export function registerCredentialPurgeHook(name: string, hook: CredentialPurgeHook): void {
  registeredHooks.set(name, hook);
}

export function resetCredentialPurgeHook(): void {
  registeredHooks.clear();
}

export function credentialPurgeHooks(): ReadonlyMap<string, CredentialPurgeHook> {
  return registeredHooks;
}

export interface CredentialPurgeOutcome {
  readonly purged: number;
  readonly failed: boolean;
}

export async function purgeSubjectCredentials(subjectId: string): Promise<CredentialPurgeOutcome> {
  let purged = 0;
  let failed = false;
  for (const [name, hook] of registeredHooks) {
    try {
      purged += await hook.purgeSubject(subjectId);
    } catch (e) {
      failed = true;
      console.warn(`[credential-purge] purge for subject failed in "${name}" (offboarding still applied): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { purged, failed };
}

export async function purgeSubjectsCredentials(subjectIds: readonly string[]): Promise<CredentialPurgeOutcome> {
  let purged = 0;
  let failed = false;
  for (const subjectId of new Set(subjectIds)) {
    const outcome = await purgeSubjectCredentials(subjectId);
    purged += outcome.purged;
    failed ||= outcome.failed;
  }
  return { purged, failed };
}
