import { processRegistryMap } from "../lib/process-registry.js";
import { connectorDisplayName } from "../access/credential-grant-copy.js";

export interface CredentialPurgeHook {
  purgeSubject(subjectId: string, report?: CredentialPurgeReport): Promise<number>;
}

export interface CredentialPurgeReport {
  unrevoked(provider: string): void;
}

const registeredHooks = processRegistryMap<CredentialPurgeHook>("credential-purge.v1");

export function registerCredentialPurgeHook(name: string, hook: CredentialPurgeHook): void {
  registeredHooks.set(name, hook);
}

export function resetCredentialPurgeHook(): void {
  registeredHooks.clear();
}

export interface CredentialPurgeOutcome {
  readonly purged: number;
  readonly failed: boolean;
  readonly unrevoked: readonly string[];
}

export async function purgeSubjectCredentials(subjectId: string): Promise<CredentialPurgeOutcome> {
  let purged = 0;
  let failed = false;
  const unrevoked = new Set<string>();
  const report: CredentialPurgeReport = { unrevoked: (provider) => void unrevoked.add(provider) };
  for (const [name, hook] of registeredHooks) {
    try {
      purged += await hook.purgeSubject(subjectId, report);
    } catch (e) {
      failed = true;
      console.warn(`[credential-purge] purge for subject failed in "${name}" (offboarding still applied): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { purged, failed, unrevoked: [...unrevoked].sort() };
}

export async function purgeSubjectsCredentials(subjectIds: readonly string[]): Promise<CredentialPurgeOutcome> {
  let purged = 0;
  let failed = false;
  const unrevoked = new Set<string>();
  for (const subjectId of new Set(subjectIds)) {
    const outcome = await purgeSubjectCredentials(subjectId);
    purged += outcome.purged;
    failed ||= outcome.failed;
    for (const provider of outcome.unrevoked) unrevoked.add(provider);
  }
  return { purged, failed, unrevoked: [...unrevoked].sort() };
}

export function unrevokedSentences(unrevoked: readonly string[]): string[] {
  return unrevoked.map((provider) => {
    const name = unrevokedDisplayName(provider);
    if (provider.startsWith(IDP_PREFIX)) {
      return `${name.slice(0, 1).toUpperCase()}${name.slice(1)} did not accept the revocation of the person's sign-in grant, after one retry. The grant is deleted here, but it stays valid at ${name} until it expires. Revoke the grant at ${name} to end it now`;
    }
    return `${name} did not accept the token revocation, after one retry. The token is deleted here, but it stays valid at ${name} until it expires. Remove the app's access in ${name} to end it now`;
  });
}

const IDP_PREFIX = "idp:";

export function unrevokedDisplayName(provider: string): string {
  if (!provider.startsWith(IDP_PREFIX)) return connectorDisplayName(provider);
  const host = provider.slice(IDP_PREFIX.length);
  return host.length > 0 ? `the identity provider (${host})` : "the identity provider";
}
