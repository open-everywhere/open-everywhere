import { credentialOverrideFor, type CredentialBoundDomain } from "./domain-credentials.js";

export function memberGrantCredential(
  domain: CredentialBoundDomain | undefined,
  connector: string,
  memberRole: string,
): string | undefined {
  const declared = credentialOverrideFor(domain, connector, memberRole);
  if (!declared) return undefined;
  return declared.use;
}

export interface MemberRole {
  readonly connector: string;
  readonly role: string;
}

export const MEMBER_ROLES: readonly MemberRole[] = [
  { connector: "notion", role: "user-oauth" },
];

export function memberGrantKey(connector: string, credentialId: string): string {
  return `${connector}/${credentialId}`;
}

export function memberPlaneGrants(domains: readonly (CredentialBoundDomain | undefined)[]): readonly string[] {
  const out = new Set<string>();
  for (const domain of domains) {
    for (const m of MEMBER_ROLES) {
      const credential = memberGrantCredential(domain, m.connector, m.role);
      if (credential !== undefined) out.add(memberGrantKey(m.connector, credential));
    }
  }
  return [...out].sort();
}
