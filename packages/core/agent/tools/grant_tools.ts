import { defineDynamic, defineTool } from "eve/tools";
import { CONVERSATIONAL_ROOT_GRAINS } from "../access/window-gate-manifest.js";
import { registerDynamicVariant, type ReplayableToolEntry } from "../access/window-gated.js";
import { runGrantedCall } from "../access/credential-grant-broker.js";
import { grantableVerb } from "../access/credential-grant.js";
import { grantToolName, type CredentialGrantRow } from "../operational/credential-grant-rows.js";
import { getOperationalStore } from "../operational/provider.js";
import { requesterThisTurn } from "../access/requester-identity.js";
import { currentSessionId, currentTurnId, windowGrainOf, type BindableContext } from "../identity/binding.js";
import { resolvePartition } from "../memory/partition.js";

export function grantToolEntry(grant: CredentialGrantRow): ReplayableToolEntry | undefined {
  const definition = grantableVerb(grant.verb);
  if (definition === undefined) return undefined;
  return defineTool({
    description: definition.describe(grant),
    inputSchema: definition.inputSchema,
    async execute(input: unknown, ctx: unknown) {
      const c = ctx as BindableContext;
      const requester = requesterThisTurn(currentTurnId(c));
      let org = "unknown";
      let platform = "unknown";
      let workspace = "unknown";
      let surface: string | undefined;
      try {
        const p = resolvePartition(c);
        org = p.org;
        platform = p.platform;
        workspace = p.workspace;
        surface = p.surface;
      } catch {
      }
      return runGrantedCall(grant.id, (input ?? {}) as Record<string, unknown>, {
        nowMs: Date.now(),
        org,
        platform,
        requesterPrincipalId: requester.kind === "requester" ? requester.principalId : undefined,
        scopeKey: currentSessionId(c) ?? "",
        ...(surface === undefined ? {} : { surface }),
        workspace,
      });
    },
  } as never) as unknown as ReplayableToolEntry;
}

export function mountGrantEntries(grants: readonly CredentialGrantRow[]): Record<string, ReplayableToolEntry> {
  const mounted: Record<string, ReplayableToolEntry> = {};
  for (const grant of grants) {
    const entry = grantToolEntry(grant);
    if (entry === undefined) continue;
    let name: string;
    try {
      name = grantToolName(grant.ownerSlug, grant.verb);
    } catch {
      continue;
    }
    registerDynamicVariant(name, grant.id, entry);
    mounted[name] = entry;
  }
  return mounted;
}

export default defineDynamic({
  events: {
    "session.started": async (_event, ctx) => {
      const c = ctx as BindableContext;
      let grain: string;
      try {
        grain = windowGrainOf(c);
      } catch {
        return null;
      }
      if (!(CONVERSATIONAL_ROOT_GRAINS as readonly string[]).includes(grain)) return null;
      const scopeKey = currentSessionId(c);
      if (scopeKey === undefined || scopeKey.length === 0) return null;
      let org: string;
      try {
        org = resolvePartition(c).org;
      } catch {
        return null;
      }
      const grants = await getOperationalStore().credentialGrantsForScope(org, scopeKey);
      const mounted = mountGrantEntries(grants);
      return Object.keys(mounted).length > 0 ? mounted : null;
    },
  },
});
