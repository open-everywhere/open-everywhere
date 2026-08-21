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

export interface WorkRole {
  readonly connector: string;
  readonly role: string;
}

export const WORK_ROLES: readonly WorkRole[] = [
  { connector: "notion", role: "team-key" },
  { connector: "linear", role: "workspace" },
];

export function workGrantedConnectors(domains: readonly (CredentialBoundDomain | undefined)[]): readonly string[] {
  const out = new Set<string>();
  for (const domain of domains) {
    for (const w of WORK_ROLES) {
      if (hasWorkGrant(domain, w.connector, w.role)) out.add(w.connector);
    }
  }
  return [...out].sort();
}
