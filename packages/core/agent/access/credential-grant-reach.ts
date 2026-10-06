import { getOperationalStore } from "../operational/provider.js";
import { classifySessionId } from "../channels/window-key.js";
import type { CredentialGrantRow } from "../operational/credential-grant-rows.js";
import { currentSessionId, delegationRootSessionId, isSubagentChildContext, type BindableContext } from "../identity/binding.js";
import { grantDomainScopeKey } from "./credential-grant-scope.js";

export function sessionScopeKeyInReach(ctx: BindableContext): string | undefined {
  try {
    if (isSubagentChildContext(ctx)) {
      const root = delegationRootSessionId(ctx);
      if (root !== undefined && root.length > 0) return root;
      const classified = classifySessionId(ctx.channel?.continuationToken);
      return classified.kind === "subagent" && classified.parentSessionId.length > 0 ? classified.parentSessionId : undefined;
    }
    const own = currentSessionId(ctx);
    return own !== undefined && own.length > 0 ? own : undefined;
  } catch {
    return undefined;
  }
}

export function domainScopeKeyInReach(ctx: BindableContext): string | undefined {
  return grantDomainScopeKey(ctx);
}

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
