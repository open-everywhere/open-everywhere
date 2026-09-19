import { getOperationalStore } from "../operational/provider.js";
import type { CredentialGrantRow } from "../operational/credential-grant-rows.js";

export async function credentialGrantsInReach(
  org: string,
  sessionScopeKey: string,
  domainScopeKey: string | undefined,
  nowIso: string,
): Promise<readonly CredentialGrantRow[]> {
  const store = getOperationalStore();
  const rows = sessionScopeKey.length > 0 ? [...(await store.credentialGrantsForScope(org, sessionScopeKey))] : [];
  if (domainScopeKey === undefined || domainScopeKey.length === 0 || domainScopeKey === sessionScopeKey) return rows;
  const seen = new Set(rows.map((r) => r.id));
  for (const row of await store.liveStandingCredentialGrantsForScope(org, domainScopeKey, nowIso)) if (!seen.has(row.id)) rows.push(row);
  return rows;
}
