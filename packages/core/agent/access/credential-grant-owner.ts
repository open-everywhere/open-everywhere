import { connectorLinkSetVaultEnabled } from "../connections/connector-flags.js";
import { rawVaultSubject } from "../identity/oauth-vault-share.js";
import { parsePrincipalKey } from "../identity/principal-key.js";
import { sharedVaultSubjectFor } from "./group-request.js";

export interface GrantOwnerSubject {
  readonly org: string;
  readonly vaultSubject: string;
  readonly platform: string;
  readonly tenant?: string;
  readonly nativeId: string;
  readonly shared: boolean;
}

export async function grantOwnerSubject(org: string, connector: string, ownerPrincipalId: string): Promise<GrantOwnerSubject | undefined> {
  const parsed = parsePrincipalKey(ownerPrincipalId);
  if (parsed === undefined) return undefined;
  const raw = rawVaultSubject(org, parsed.platform, parsed.tenant, parsed.id);
  const shared = connectorLinkSetVaultEnabled()
    ? await sharedVaultSubjectFor(org, connector, parsed.platform, parsed.id, parsed.tenant)
    : undefined;
  return {
    nativeId: parsed.id,
    org,
    platform: parsed.platform,
    shared: shared !== undefined,
    ...(parsed.tenant === undefined ? {} : { tenant: parsed.tenant }),
    vaultSubject: shared ?? raw,
  };
}
