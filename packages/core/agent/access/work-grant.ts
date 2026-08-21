import { credentialOverrideFor, type CredentialBoundDomain } from "./domain-credentials.js";

export function workGrantCredential(
  domain: CredentialBoundDomain | undefined,
  connector: string,
  workRole: string,
): string | undefined {
  const declared = credentialOverrideFor(domain, connector, workRole);
  if (!declared) return undefined;
  return declared.use;
}

export function hasWorkGrant(
  domain: CredentialBoundDomain | undefined,
  connector: string,
  workRole: string,
): boolean {
  return workGrantCredential(domain, connector, workRole) !== undefined;
}
