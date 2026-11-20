import { defineHook, type HookContext } from "eve/hooks";
import { call } from "eve/events";
import { appendAudit } from "../audit/audit.js";
import { auditSurfaceModeStamp, bindFrom, currentTurnId, deploymentOrg, type BindableContext } from "../identity/binding.js";
import type { SessionMode } from "../access/resolver.js";
import { resolvePartition } from "../memory/partition.js";
import { connectorOpName, isConnectorOpTool, parseQualifiedToolName } from "../access/consequence.js";
import { canonicalConnectorOpName } from "../access/connector-op-alias.js";
import { connectorOpConsequenceOfTier, connectorOpTierParts } from "../access/connector-op-gating.js";
import { connectorOpToolHints } from "../connections/connector-tool-hints.js";
import { noteConnectorRead, PROVENANCE_READ_TIER } from "../channels/reply-provenance.js";
import { stampReadReach } from "../channels/read-reach.js";
import { noteDelegatedRead } from "../channels/delegated-provenance.js";
import { noteGatedConnectorWrite } from "../channels/standing-authority.js";
import { optional } from "./control-refusal.js";
import { auditUngrantedConnectorAttempt } from "../access/connector-scope.js";
import { mountedConnectorNames } from "../connections/connector-catalogue.js";
import { personalSurfaceFenced } from "../connections/personal-surface-fence.js";

async function auditOpResult(event: { readonly data: { readonly callId: string; readonly outcome: string } }, ctx: HookContext): Promise<void> {
  const observed = call(ctx.view, event.data.callId);
  if (observed === undefined || observed.kind !== "tool") return;
  const toolName = observed.name;
  if (typeof toolName !== "string" || !isConnectorOpTool(toolName)) return;
  if (parseQualifiedToolName(toolName)?.namespace !== undefined) return;

  const qualified = canonicalConnectorOpName(toolName);
  const connection = qualified.slice(0, qualified.indexOf("__"));
  const op = connectorOpName(toolName);
  const status = event.data.outcome;
  if (status === "interrupted" || status === "abandoned") return;
  const result = { isError: status !== "completed" };
  const tiers = connectorOpTierParts(toolName, undefined, await connectorOpToolHints(toolName));

  let org = deploymentOrg();
  let platform = "unknown";
  let workspace = "unknown";
  let surface: string | undefined;
  let surfaceKey: string | undefined;
  let principalId: string | undefined;
  let surfaceMode: SessionMode | undefined;
  try {
    const p = resolvePartition(ctx as unknown as BindableContext);
    org = p.org;
    platform = p.platform;
    workspace = p.workspace;
    surface = p.surface;
    surfaceKey = p.surfaceKey;
    const binding = bindFrom(ctx as unknown as BindableContext);
    principalId = binding.principalId;
    surfaceMode = auditSurfaceModeStamp(binding).surfaceMode;
  } catch {
  }

  if (!result.isError && tiers.tier === PROVENANCE_READ_TIER) {
    const bind = ctx as unknown as BindableContext;
    const turnId = currentTurnId(bind);
    noteConnectorRead(turnId, { ...stampReadReach(bind, turnId, surfaceKey), connection, op });
    noteDelegatedRead(bind, connection, op);
  }

  if (!result.isError && (tiers.tier === "write" || tiers.tier === "destructive")) {
    noteGatedConnectorWrite(currentTurnId(ctx as unknown as BindableContext), { connection, op, tier: tiers.tier });
  }

  await appendAudit({
    org,
    platform,
    workspace,
    surface,
    ...(surfaceMode === undefined ? {} : { surfaceMode }),
    principalId,
    action: "connector.op",
    detail: {
      connection,
      op,
      tier: connectorOpConsequenceOfTier(tiers.tier),
      opTier: tiers.tier,
      ...(tiers.tier !== tiers.base ? { baseOpTier: tiers.base } : {}),
      ...(tiers.armReplaced ? { opTierArmReplaced: true } : {}),
      ...(tiers.arm !== undefined ? { armOpTier: tiers.arm } : {}),
      ...(tiers.armLowered ? { opTierArmLowered: true, opTierBasis: tiers.basis } : {}),
      ...(tiers.hint !== undefined ? { opTierHint: tiers.hint } : {}),
      ...(tiers.hintDecided ? { opTierHintDecided: true, opTierBasis: tiers.basis } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(result.isError ? { isError: true } : {}),
    },
  });
}

const SEARCH_TOOL = "eve__search";
const MAX_SEEN_CALLS = 1024;
/** The attempts this process wrote, by call and connection. A fact delivered again here writes no second row. */
const seenAttempts = new Set<string>();

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The mounted connections one requested call names. Only an `eve__search` names one: its query
 * holds `<connection>__`, or the connection's name as a word. A `-` joins a word, so a search for
 * `slack-as-you` does not name `slack`.
 *
 * Other shapes cannot be read here, and that is measured on eve 1.x. An `eve__tool` call that names
 * an entry the step does not offer fails the AI SDK's input check, and a direct call to a tool the
 * step does not offer fails as an unknown tool: eve writes no `call.requested` fact for either. An
 * `eve__tool` call that names an offered op becomes that op's own call, and the call-time gate
 * audits it.
 */
export function connectorAttemptsOf(
  data: { readonly capability: { readonly name: string }; readonly input?: unknown },
  names: readonly string[] = mountedConnectorNames(),
): readonly string[] {
  if (data.capability.name !== SEARCH_TOOL || names.length === 0) return [];
  const query = data.input !== null && typeof data.input === "object" ? (data.input as { query?: unknown }).query : undefined;
  if (typeof query !== "string") return [];
  const lower = query.toLowerCase();
  return names.filter((connection) => connection.length > 0 && new RegExp(`(^|[^a-z0-9-])${escapeRegExp(connection.toLowerCase())}([^a-z0-9-]|$)`).test(lower));
}

/**
 * The permission-proposal evidence for an ungranted connector (`access/permission-evidence.ts`).
 * On eve 1.x a connector mount offers a surface without the grant no op, so the model can only
 * search for the connection. Each such search writes one `connector.refused` row with reason
 * `ungranted` when the surface does not hold the connection. The row changes no grant and refuses
 * no call: eve settles the search as before.
 */
async function auditConnectorAttempt(
  event: { readonly data: { readonly callId: string; readonly capability: { readonly name: string }; readonly input?: unknown } },
  ctx: HookContext,
): Promise<void> {
  const connections = connectorAttemptsOf(event.data);
  if (connections.length === 0) return;
  const auth = (ctx as { session?: { auth?: unknown } }).session?.auth;
  if (auth === undefined || auth === null) return;
  for (const connection of connections) {
    const key = `${event.data.callId}\0${connection}`;
    if (seenAttempts.has(key)) continue;
    if (seenAttempts.size >= MAX_SEEN_CALLS) {
      const oldest = seenAttempts.values().next().value;
      if (oldest !== undefined) seenAttempts.delete(oldest);
    }
    seenAttempts.add(key);
    // A personal-surface connection off its platform's DM is fenced, not ungranted: a grant would
    // not reach it, so the search is no evidence for one.
    if (await personalSurfaceFenced(connection, auth as Parameters<typeof personalSurfaceFenced>[1])) continue;
    await auditUngrantedConnectorAttempt(connection, auth as Parameters<typeof auditUngrantedConnectorAttempt>[1], { via: SEARCH_TOOL });
  }
}

export default defineHook({
  events: {
    "call.requested": optional("connector-audit", (event, ctx) => auditConnectorAttempt(event, ctx)),
    "call.settled": optional("connector-audit", (event, ctx) => auditOpResult(event, ctx)),
  },
});
