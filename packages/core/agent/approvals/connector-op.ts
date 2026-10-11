import { appendAudit } from "../audit/audit.js";
import { getConfig } from "../access/config.js";
import { surfaceContextFromAuth } from "../access/connector-scope.js";
import { actingPrincipalIdOf, unattendedOf } from "../access/request.js";
import { bindFrom } from "../identity/binding.js";
import { resolvePartition } from "../memory/partition.js";
import { getOperationalStore } from "../operational/provider.js";
import { registerActionKind, whereFromScope } from "./actions.js";
import { checkApprovalVenue, describeVenueRefusal } from "./card-venue.js";
import { CONNECTOR_OP_CARD_KIND, connectorArgsWithoutInput, connectorCardContext, registerConnectorOpCardOfferer, registerSignInCardDeliverer, type ConnectorOpCardOffer, type ConnectorOpCardResult, type SignInCardOffer } from "./connector-op-offer.js";
import { deliverProactiveDm, dmDeliveryFooter, personAddress } from "../channels/dm-audience.js";
import { canDeliverDirectMessage } from "../channels/post-arms.js";
import type { ActionKind } from "./types.js";
import { approvalPostDeps, requestApproval } from "./flow.js";
import type { SessionAuth } from "eve/context";
import { plainValue } from "./plain-text.js";

const CONNECTOR_OP_KIND = "op.connector";
const CONNECTOR_OP_KIND_MATCHES_OFFER: typeof CONNECTOR_OP_CARD_KIND = CONNECTOR_OP_KIND;
void CONNECTOR_OP_KIND_MATCHES_OFFER;

const CONNECTOR_OP_APPROVED_ACTION = "connector.op_approved";

interface ConnectorOpArgs {
  readonly org: string;
  readonly scopeKey: string;
  readonly tool: string;
  readonly connection: string;
  readonly grain: ConnectorOpCardOffer["grain"];
  readonly opTier?: ConnectorOpCardOffer["opTier"];
  readonly sessionKey: string;
  readonly memoKind: string;
  readonly inputPreview: string;
  readonly input?: Readonly<Record<string, unknown>>;
  readonly inputCleared?: true;
  readonly requestedBy: string;
  readonly tainted?: boolean;
  readonly credential?: "domain" | "personal";
}

export const ONE_CALL_APPROVAL_TTL_HOURS = 24;

function summarizeConnectorOp(args: ConnectorOpArgs): string[] {
  const tier = args.grain === "destructive" ? "destructive-tier " : "";
  return [
    `Run the ${tier}op "${args.tool}" on connection "${args.connection}" — approves this one call, with exactly this input`,
    `Input: ${args.inputPreview}`,
  ];
}

const REPLAY_TARGET_SEGMENT = /^[A-Za-z0-9_.:-]{1,128}$/u;

function connectorReplayTarget(args: ConnectorOpArgs): { connection: string; tool: string } | undefined {
  if (args.input === undefined || args.input === null || typeof args.input !== "object") return undefined;
  const prefix = `${args.connection}__`;
  if (!args.tool.startsWith(prefix)) return undefined;
  const tool = args.tool.slice(prefix.length);
  if (!REPLAY_TARGET_SEGMENT.test(args.connection) || !REPLAY_TARGET_SEGMENT.test(tool)) return undefined;
  return { connection: args.connection, tool };
}

const connectorOp: ActionKind<ConnectorOpArgs> = {
  kind: CONNECTOR_OP_KIND,
  policy: "member",
  approvalArmsCall: true,
  armedCallReplay: (args) => connectorReplayTarget(args),
  argsAfterClose: (args) => connectorArgsWithoutInput(args),
  plainSummary: (args) =>
    `Run ${plainValue(args.tool)} once on the ${plainValue(args.connection)} connection${args.grain === "destructive" ? " — this deletes or overwrites data" : ""}`,
  summarize: (args) => summarizeConnectorOp(args),
  async execute(args, decidedBy) {
    if (decidedBy.startsWith("chain:")) {
      await appendAudit({
        ...whereFromScope(args.org, args.scopeKey),
        principalId: args.requestedBy,
        action: CONNECTOR_OP_APPROVED_ACTION,
        detail: { connection: args.connection, op: args.tool, grain: args.grain, requestedBy: args.requestedBy, decidedBy },
      });
      return `approved by ${decidedBy} — "${args.tool}" runs this one call now`;
    }
    const now = new Date();
    const ttlMs = ONE_CALL_APPROVAL_TTL_HOURS * 60 * 60 * 1000;
    await getOperationalStore().setSessionApproval({
      org: args.org,
      sessionId: args.sessionKey,
      kind: args.memoKind,
      grantedBy: decidedBy,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    });
    await appendAudit({
      ...whereFromScope(args.org, args.scopeKey),
      principalId: decidedBy,
      action: CONNECTOR_OP_APPROVED_ACTION,
      detail: { connection: args.connection, op: args.tool, grain: args.grain, requestedBy: args.requestedBy },
    });
    return `approved — "${args.tool}" may run once with this input; the agent must call it again`;
  },
};

registerActionKind(connectorOp);

export { connectorCardContext };

function singleDomainOf(p: { readonly platform: string; readonly workspace: string; readonly surface?: string }): string | undefined {
  if (p.surface === undefined) return undefined;
  try {
    const domains = getConfig().domainsForSurface({ workspaceKey: `${p.platform}/${p.workspace}`, surface: p.surface });
    return domains.length === 1 ? domains[0] : undefined;
  } catch {
    return undefined;
  }
}

export function connectorOpArgsFromOffer(offer: ConnectorOpCardOffer, room: { readonly scopeKey: string; readonly requestedBy: string }): ConnectorOpArgs {
  return {
    org: offer.org,
    scopeKey: room.scopeKey,
    tool: offer.tool,
    connection: offer.connection,
    grain: offer.grain,
    ...(offer.opTier === undefined ? {} : { opTier: offer.opTier }),
    sessionKey: offer.sessionKey,
    memoKind: offer.memoKind,
    inputPreview: offer.inputPreview,
    ...(offer.input === undefined ? {} : { input: offer.input }),
    requestedBy: room.requestedBy,
    ...(offer.tainted ? { tainted: true } : {}),
    ...(offer.credential === undefined ? {} : { credential: offer.credential }),
  };
}

export async function offerConnectorCard(offer: ConnectorOpCardOffer, deps: { readonly request?: typeof requestApproval } = {}): Promise<ConnectorOpCardResult> {
  const surface = offer.auth === undefined || offer.auth === null ? null : await surfaceContextFromAuth(offer.auth as SessionAuth).catch(() => null);
  if (surface === null) return { outcome: "refused", reason: "this call names no conversation a card could be posted to" };
  const ctx = connectorCardContext(surface, offer.session);
  const requestedBy = actingPrincipalIdOf(ctx);
  if (!requestedBy) return { outcome: "refused", reason: "this turn has no verified sender to name on an approval card" };
  const binding = bindFrom(ctx);
  const p = resolvePartition(ctx);
  const venueResult = await checkApprovalVenue(binding, p, () => getConfig().loadDomains());
  if ("refusal" in venueResult) return { outcome: "refused", reason: describeVenueRefusal(venueResult.refusal, binding.platform, `run ${offer.tool}`) };
  const venue = venueResult.venue;
  const domain = singleDomainOf(p);
  const args = connectorOpArgsFromOffer(offer, { scopeKey: p.surfaceKey, requestedBy });
  const request = deps.request ?? requestApproval;
  const posted = await request(
    {
      org: offer.org,
      kind: CONNECTOR_OP_KIND,
      args,
      scopeKey: p.surfaceKey,
      domain: null,
      requestedBy,
      channelId: venue.channelId,
      threadTs: venue.sameRoom ? (binding.threadTs ?? null) : null,
      postedTo: venue.surfaceKey,
      chain: { unattended: unattendedOf(ctx), tainted: offer.tainted, ...(domain === undefined ? {} : { domain }) },
    },
    approvalPostDeps(venue.platform, ctx),
  );
  if (posted.autoApproved) return { outcome: "approved" };
  return { outcome: "carded", pendingId: posted.id, where: venue.sameRoom ? "in this conversation" : `in ${venue.surfaceKey}` };
}

registerConnectorOpCardOfferer((offer) => offerConnectorCard(offer));

function signInCardText(offer: SignInCardOffer): string {
  return (
    `🔐 A job you asked for needs your own ${offer.connector} account, and it is not connected yet. ` +
    `Open this personal link to connect it (it expires soon): ${offer.url}\n` +
    "When you have connected it, say so in the conversation, and the agent runs the job again. Nothing ran yet."
  );
}

async function deliverSignIn(offer: SignInCardOffer): Promise<boolean> {
  if (!canDeliverDirectMessage(offer.platform)) return false;
  await deliverProactiveDm({
    where: { org: offer.org, platform: offer.platform, workspace: offer.workspace, ...(offer.surface === undefined ? {} : { surface: offer.surface }) },
    plane: "connector.sign_in",
    platform: offer.platform,
    recipientId: offer.recipientId,
    address: personAddress(offer.platform, offer.recipientId),
    text: signInCardText(offer),
    footer: dmDeliveryFooter({ requestedBy: offer.recipientId, fromContainer: offer.fromContainer }),
    requestedBy: offer.recipientId,
    attributedTo: offer.recipientId,
  });
  return true;
}

registerSignInCardDeliverer(deliverSignIn);
