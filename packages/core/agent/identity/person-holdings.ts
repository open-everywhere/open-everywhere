import { cascadeRevokeOwnerGrants } from "../access/credential-grant-revoke.js";
import { forgetBrowser } from "../personal-browser/lifecycle.js";
import { tryPrincipalKey } from "./principal-key.js";

export interface HoldingsEnded {
  readonly grantsRevoked: number;
  readonly browsersForgotten: number;
  readonly holdingFailures?: readonly string[];
}

export async function endPersonHoldings(
  org: string,
  accounts: readonly { readonly platform: string; readonly tenant: string; readonly nativeId: string }[],
  actor: string,
): Promise<HoldingsEnded> {
  let grantsRevoked = 0;
  let browsersForgotten = 0;
  const failures: string[] = [];
  for (const a of accounts) {
    const key = tryPrincipalKey(a.platform, a.tenant, a.nativeId);
    if (key === undefined) continue;
    try {
      grantsRevoked += await cascadeRevokeOwnerGrants({ org, platform: a.platform, workspace: a.tenant || "-" }, key, actor, Date.now());
    } catch (err) {
      failures.push(`credential grants of ${key}: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      if ((await forgetBrowser(org, key, {}, actor)).existed) browsersForgotten++;
    } catch (err) {
      failures.push(`personal browser of ${key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { grantsRevoked, browsersForgotten, ...(failures.length > 0 ? { holdingFailures: failures } : {}) };
}
