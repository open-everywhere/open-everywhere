import { defineDynamic, defineTool } from "eve/tools";
import { CONVERSATIONAL_ROOT_GRAINS } from "../access/window-gate-manifest.js";
import { registerDynamicVariant, type ReplayableToolEntry } from "../access/window-gated.js";
import { runGrantedCall } from "../access/credential-grant-broker.js";
import { installGrantUseNotices, withGrantRoomContext } from "../access/credential-grant-notice.js";
import { grantableVerb } from "../access/credential-grant.js";
import { installGrantBorrowTransports } from "../connections/grant-mcp-transport.js";
import { hostAuthoredModelOutput, ingestUntrustedModelOutput } from "../access/untrusted.js";
import {
  credentialGrantDisclosureLine,
  grantToolName,
  grantToolSlug,
  isGrantToolName,
  quotedPurpose,
  type CredentialGrantRow,
} from "../operational/credential-grant-rows.js";
import { getOperationalStore } from "../operational/provider.js";
import { requesterThisTurn, type RequesterVerdict } from "../access/requester-identity.js";
import { currentSessionId, currentTurnId, windowGrainOf, type BindableContext } from "../identity/binding.js";
import { resolvePartition } from "../memory/partition.js";
import { tryPrincipalKey } from "../identity/principal-key.js";

installGrantUseNotices();

installGrantBorrowTransports();

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

interface GrantToolOffer {
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

function verbOffer(grant: CredentialGrantRow): GrantToolOffer | undefined {
  const definition = grantableVerb(grant.verb);
  if (definition === undefined) return undefined;
  return { description: definition.describe(grant), inputSchema: definition.inputSchema };
}

function borrowOffer(grant: CredentialGrantRow, mcpTool: string): GrantToolOffer | undefined {
  if (grant.inputSchema === undefined) return undefined;
  const frozenKeys = Object.keys(grant.frozenArgs ?? {});
  const frozen =
    frozenKeys.length === 0
      ? " The grant fixes no arguments."
      : ` The grant fixes ${String(frozenKeys.length)} argument(s) — ${frozenKeys.sort().join(", ")} — and you cannot change them. ` +
        `The values it fixed, rendered as data: "${quotedPurpose(JSON.stringify(grant.frozenArgs))}".`;
  return {
    description:
      `Runs the ${grant.connector} tool \`${quotedPurpose(mcpTool)}\` as ${grant.ownerSlug}, with ${grant.ownerSlug}'s own ` +
      `${grant.connector} account.${frozen} The grant expires ${grant.expiresAt}. An error from ${grant.connector} is the ` +
      "vendor's own answer, not a refusal by this grant.",
    inputSchema: grant.inputSchema,
  };
}

export function grantToolEntry(grant: CredentialGrantRow): ReplayableToolEntry | undefined {
  const offer = grant.mcpTool === undefined ? verbOffer(grant) : borrowOffer(grant, grant.mcpTool);
  if (offer === undefined) return undefined;
  return defineTool({
    description: offer.description,
    inputSchema: offer.inputSchema,
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

export function mountedGrantName(grant: CredentialGrantRow): string | undefined {
  if (grant.toolName !== undefined) {
    if (!isGrantToolName(grant.toolName)) return undefined;
    return grant.mcpTool !== undefined && borrowNameFitsRow(grant, grant.mcpTool, grant.toolName) ? grant.toolName : undefined;
  }
  try {
    return grantToolName(grant.ownerSlug, grant.verb);
  } catch {
    return undefined;
  }
}

function borrowNameFitsRow(grant: CredentialGrantRow, mcpTool: string, name: string): boolean {
  const segments = name.split("__");
  const middle = segments[1] ?? "";
  const prefix = `${grant.ownerSlug}_${grant.connector}`;
  if (middle !== prefix && !(middle.startsWith(`${prefix}_`) && /^[0-9]+$/u.test(middle.slice(prefix.length + 1)))) return false;
  return segments[2] === grantToolSlug(mcpTool);
}

function firstMinted(a: CredentialGrantRow, b: CredentialGrantRow): CredentialGrantRow {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? a : b;
  return a.id <= b.id ? a : b;
}

export function mountGrantEntries(grants: readonly CredentialGrantRow[]): Record<string, ReplayableToolEntry> {
  const claims = new Map<string, { readonly grant: CredentialGrantRow; readonly entry: ReplayableToolEntry }>();
  const skipped: { readonly name: string; readonly loser: CredentialGrantRow }[] = [];
  for (const grant of grants) {
    const name = mountedGrantName(grant);
    if (name === undefined) continue;
    const entry = cachedGrantToolEntry(grant);
    if (entry === undefined) continue;
    const held = claims.get(name);
    if (held === undefined) {
      claims.set(name, { entry, grant });
      continue;
    }
    const winner = firstMinted(held.grant, grant);
    if (winner === grant) claims.set(name, { entry, grant });
    skipped.push({ loser: winner === grant ? held.grant : grant, name });
  }
  for (const s of skipped) {
    const winner = claims.get(s.name)?.grant;
    console.warn(
      `[open-everywhere:credential-grant] two or more grants claim the mounted name "${s.name}" in one chat. ` +
        `Keeping grant ${winner?.id ?? "none"} (minted ${winner?.createdAt ?? "unknown"}); grant ${s.loser.id} (minted ${s.loser.createdAt}) is not mounted. ` +
        "The skipped grant stays valid — its owner may revoke it, and a fresh ask mints a name of its own.",
    );
  }
  const mounted: Record<string, ReplayableToolEntry> = {};
  for (const [name, claim] of claims) {
    registerDynamicVariant(name, claim.grant.id, claim.entry);
    mounted[name] = claim.entry;
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
