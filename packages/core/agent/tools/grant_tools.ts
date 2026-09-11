import { defineDynamic, defineTool } from "eve/tools";
import { CONVERSATIONAL_ROOT_GRAINS } from "../access/window-gate-manifest.js";
import { registerDynamicVariant, type ReplayableToolEntry } from "../access/window-gated.js";
import { GRANT_REFUND_CAP_PER_TURN, runGrantedCall } from "../access/credential-grant-broker.js";
import { installGrantUseNotices, withGrantRoomContext } from "../access/credential-grant-notice.js";
import { installGrantBorrowTransports } from "../connections/grant-mcp-transport.js";
import { hostAuthoredModelOutput, ingestUntrustedModelOutput } from "../access/untrusted.js";
import {
  credentialGrantDisclosureLine,
  grantResourceTargetLabel,
  grantToolSlug,
  isGrantToolName,
  quotedPurpose,
  type CredentialGrantRow,
} from "../operational/credential-grant-rows.js";
import { connectorDisplayName, grantActionIsReviewed, grantActionPhrase, grantExpiryPhrase, grantOwnerPhrase } from "../access/credential-grant-copy.js";
import { getOperationalStore } from "../operational/provider.js";
import { requesterThisTurn, type RequesterVerdict } from "../access/requester-identity.js";
import { currentSessionId, currentTurnId, windowGrainOf, type BindableContext } from "../identity/binding.js";
import { resolvePartition } from "../memory/partition.js";
import { tryPrincipalKey } from "../identity/principal-key.js";

installGrantUseNotices();

installGrantBorrowTransports();

function grantModelProjection(grant: CredentialGrantRow): (output: unknown) => Promise<{ type: "text"; value: string }> {
  const source = `granted ${grant.verb} as ${grant.ownerSlug} — ${grant.connector} ${grant.resource}`;
  const label = `grant:${grant.connector}:${grant.verb}`;
  return async (output: unknown) => {
    const row = typeof output === "object" && output !== null ? (output as Record<string, unknown>) : undefined;
    if (row?.ok === false && typeof row.message === "string") return hostAuthoredModelOutput(row.message, { source });
    const body = row?.ok === true ? row.result : output;
    const fenced = await ingestUntrustedModelOutput(typeof body === "string" ? body : JSON.stringify(body ?? null), {
      ingestion: { kind: "connector", label },
      source,
    });
    const disclosure = typeof row?.disclosure === "string" ? row.disclosure : credentialGrantDisclosureLine(grant, Date.now());
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

function borrowOffer(grant: CredentialGrantRow, mcpTool: string, nowMs: number): GrantToolOffer | undefined {
  if (grant.inputSchema === undefined) return undefined;
  const owner = grantOwnerPhrase(grant.ownerSlug);
  const vendor = connectorDisplayName(grant.connector);
  const frozenKeys = Object.keys(grant.frozenArgs ?? {}).sort();
  const frozen =
    frozenKeys.length === 0
      ? `This grant fixes no arguments — ${owner} lent the tool itself, so you choose every argument.`
      : `${String(frozenKeys.length)} argument(s) are FIXED by the grant — ${frozenKeys.join(", ")}. Each one's schema shows the single ` +
        "value it may carry: SEND EXACTLY THAT. A call that sends any other value for a fixed argument, or omits one, is " +
        `refused before the call reaches ${vendor}` +
        `${
          grant.mode === "once"
            ? `, and this is a ONE-SHOT grant: a refusal that never reached ${vendor} gives the grant back, but only for the first ${String(GRANT_REFUND_CAP_PER_TURN)} refusals of this grant in one turn — after that it stays spent and this tool is finished. Each attempt also opens a session under ${owner}'s account, so send the exact value rather than guessing`
            : ""
        }.`;
  const target = grantResourceTargetLabel(grant);
  const on = target === undefined || target.length === 0 ? "" : ` — "${target}"`;
  const vague = grantActionIsReviewed(grant.connector, mcpTool) ? "" : ` (this deployment has no reviewed description for the exact ${vendor} tool, so the reach may be wider than that phrase suggests)`;
  return {
    description:
      `Uses ${owner}'s own ${vendor} account to ${grantActionPhrase(grant.connector, mcpTool)}${on}${vague}. ${frozen} ` +
      `The grant runs ${grantExpiryPhrase(grant.expiresAt, nowMs)}. An error from ${vendor} is the vendor's own answer, not a refusal by this grant.`,
    inputSchema: grant.inputSchema,
  };
}

export function grantToolEntry(grant: CredentialGrantRow, nowMs: number = Date.now()): ReplayableToolEntry | undefined {
  const mcpTool = grant.mcpTool;
  if (mcpTool === undefined) return undefined;
  const offer = borrowOffer(grant, mcpTool, nowMs);
  if (offer === undefined) return undefined;
  return defineTool({
    description: offer.description,
    inputSchema: offer.inputSchema,
    async execute(input: unknown, ctx: unknown) {
      const c = ctx as BindableContext;
      const turnId = currentTurnId(c);
      const requester = requesterThisTurn(turnId);
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
      return withGrantRoomContext({ ctx: c, org, platform, workspace, ...(surface === undefined ? {} : { surface }) }, () =>
        runGrantedCall(grant.id, (input ?? {}) as Record<string, unknown>, {
          nowMs: Date.now(),
          org,
          platform,
          requesterPrincipalId: requesterKeyForGrantCall(platform, workspace, requester),
          scopeKey: currentSessionId(c) ?? "",
          ...(surface === undefined ? {} : { surface }),
          ...(turnId === undefined ? {} : { turnId }),
          workspace,
        }),
      );
    },
    toModelOutput: grantModelProjection(grant),
  } as never) as unknown as ReplayableToolEntry;
}

const GRANT_ENTRIES = new Map<string, { readonly fingerprint: string; readonly entry: ReplayableToolEntry }>();

function cachedGrantToolEntry(grant: CredentialGrantRow): ReplayableToolEntry | undefined {
  const nowMs = Date.now();
  const fingerprint = `${JSON.stringify(grant)}|${grantExpiryPhrase(grant.expiresAt, nowMs)}`;
  const held = GRANT_ENTRIES.get(grant.id);
  if (held !== undefined && held.fingerprint === fingerprint) return held.entry;
  const entry = grantToolEntry(grant, nowMs);
  if (entry === undefined) return undefined;
  GRANT_ENTRIES.set(grant.id, { entry, fingerprint });
  return entry;
}

export function mountedGrantName(grant: CredentialGrantRow): string | undefined {
  if (grant.toolName === undefined) return undefined;
  if (!isGrantToolName(grant.toolName)) return undefined;
  return grant.mcpTool !== undefined && borrowNameFitsRow(grant, grant.mcpTool, grant.toolName) ? grant.toolName : undefined;
}

function borrowNameFitsRow(grant: CredentialGrantRow, mcpTool: string, name: string): boolean {
  const segments = name.split("__");
  if (segments[1] !== `${grant.ownerSlug}_${grant.connector}`) return false;
  const toolSlug = grantToolSlug(mcpTool);
  const verb = segments[2] ?? "";
  return toolSlug !== undefined && (verb === toolSlug || verb.startsWith(`${toolSlug}_`));
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
        "The skipped grant stays valid — its owner can end it from their own direct messages (`revoke_credential_grant`), and a fresh ask mints a name of its own.",
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
