import { effectiveUserVaultSubject } from "../connections/connector-auth.js";
import { parsePrincipalKey } from "../identity/principal-key.js";

export interface GrantOwnerSubject {
  readonly org: string;
  readonly vaultSubject: string;
}

export async function grantOwnerSubject(org: string, connector: string, ownerPrincipalId: string): Promise<GrantOwnerSubject | undefined> {
  const parsed = parsePrincipalKey(ownerPrincipalId);
  if (parsed === undefined) return undefined;
  try {
    return { org, vaultSubject: await effectiveUserVaultSubject(connector, org, parsed.platform, parsed.tenant, parsed.id) };
  } catch {
    return undefined;
  }
}
