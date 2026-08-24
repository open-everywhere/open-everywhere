import { defineDynamic, defineTool } from "eve/tools";
import { CONVERSATIONAL_ROOT_GRAINS } from "../access/window-gate-manifest.js";
import { registerDynamicVariant, type ReplayableToolEntry } from "../access/window-gated.js";
import { runGrantedCall } from "../access/credential-grant-broker.js";
import { installGrantUseNotices, withGrantRoomContext } from "../access/credential-grant-notice.js";
import { grantableVerb } from "../access/credential-grant.js";
import { hostAuthoredModelOutput, ingestUntrustedModelOutput } from "../access/untrusted.js";
import { credentialGrantDisclosureLine, grantToolName, type CredentialGrantRow } from "../operational/credential-grant-rows.js";
import { getOperationalStore } from "../operational/provider.js";
import { requesterThisTurn, type RequesterVerdict } from "../access/requester-identity.js";
import { currentSessionId, currentTurnId, windowGrainOf, type BindableContext } from "../identity/binding.js";
import { resolvePartition } from "../memory/partition.js";
import { tryPrincipalKey } from "../identity/principal-key.js";

installGrantUseNotices();

function grantModelProjection(grant: CredentialGrantRow): (output: unknown) => { type: "text"; value: string } {
  const source = `granted ${grant.verb} as ${grant.ownerSlug} — ${grant.connector} ${grant.resource}`;
  const label = `grant:${grant.connector}:${grant.verb}`;
  return (output: unknown) => {
    const row = typeof output === "object" && output !== null ? (output as Record<string, unknown>) : undefined;
    if (row?.ok === false && typeof row.message === "string") return hostAuthoredModelOutput(row.message, { source });
    const body = row?.ok === true ? row.result : output;
    const fenced = ingestUntrustedModelOutput(typeof body === "string" ? body : JSON.stringify(body ?? null), {
      ingestion: { kind: "connector", label },
      source,
    });
    const disclosure = typeof row?.disclosure === "string" ? row.disclosure : credentialGrantDisclosureLine(grant);
    return { type: "text", value: `${fenced.value}\n\n${disclosure}` };
  };
}

export function requesterKeyForGrantCall(platform: string, workspace: string, verdict: RequesterVerdict): string | undefined {
  return verdict.kind === "requester" ? tryPrincipalKey(platform, workspace, verdict.principalId) : undefined;
}

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
      return withGrantRoomContext({ ctx: c, org }, () =>
        runGrantedCall(grant.id, (input ?? {}) as Record<string, unknown>, {
          nowMs: Date.now(),
          org,
          platform,
          requesterPrincipalId: requesterKeyForGrantCall(platform, workspace, requester),
          scopeKey: currentSessionId(c) ?? "",
          ...(surface === undefined ? {} : { surface }),
          workspace,
        }),
      );
    },
    toModelOutput: grantModelProjection(grant),
  } as never) as unknown as ReplayableToolEntry;
}

const GRANT_ENTRIES = new Map<string, { readonly fingerprint: string; readonly entry: ReplayableToolEntry }>();

function cachedGrantToolEntry(grant: CredentialGrantRow): ReplayableToolEntry | undefined {
  const fingerprint = JSON.stringify(grant);
  const held = GRANT_ENTRIES.get(grant.id);
  if (held !== undefined && held.fingerprint === fingerprint) return held.entry;
  const entry = grantToolEntry(grant);
  if (entry === undefined) return undefined;
  GRANT_ENTRIES.set(grant.id, { entry, fingerprint });
  return entry;
}

export function mountGrantEntries(grants: readonly CredentialGrantRow[]): Record<string, ReplayableToolEntry> {
  const mounted: Record<string, ReplayableToolEntry> = {};
  for (const grant of grants) {
    const entry = cachedGrantToolEntry(grant);
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

async function resolveGrantMount(ctx: unknown): Promise<Record<string, ReplayableToolEntry> | null> {
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
}

export default defineDynamic({
  events: {
    "session.started": async (_event, ctx) => await resolveGrantMount(ctx),
    "turn.started": async (_event, ctx) => await resolveGrantMount(ctx),
  },
});
