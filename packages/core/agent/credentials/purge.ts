export interface CredentialPurgeHook {
  purgeSubject(subjectId: string): Promise<number>;
}

let registeredHook: CredentialPurgeHook | undefined;

export function registerCredentialPurgeHook(hook: CredentialPurgeHook): void {
  registeredHook = hook;
}

export function resetCredentialPurgeHook(): void {
  registeredHook = undefined;
}

export function credentialPurgeHook(): CredentialPurgeHook | undefined {
  return registeredHook;
}

export interface CredentialPurgeOutcome {
  readonly purged: number;
  readonly failed: boolean;
}

export async function purgeSubjectCredentials(subjectId: string): Promise<CredentialPurgeOutcome> {
  const hook = registeredHook;
  if (!hook) return { purged: 0, failed: false };
  try {
    return { purged: await hook.purgeSubject(subjectId), failed: false };
  } catch (e) {
    console.warn(`[credential-purge] purge for subject failed (offboarding still applied): ${e instanceof Error ? e.message : String(e)}`);
    return { purged: 0, failed: true };
  }
}
