import { toolWords } from "../routines/schedule-words.js";
import { QUOTE_MAX, plainQuote } from "./plain-text.js";
import { placeWords } from "../channels/friendly-ids.js";
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
import { connectorDisplayName } from "../access/credential-grant-copy.js";
import type { ActionKind } from "./types.js";
import { approvalPostDeps, requestApproval } from "./flow.js";
import type { SessionAuth } from "eve/context";
import { plainOpWords } from "./plain-text.js";

const CONNECTOR_OP_KIND = "op.connector";
const CONNECTOR_OP_KIND_MATCHES_OFFER: typeof CONNECTOR_OP_CARD_KIND = CONNECTOR_OP_KIND;
void CONNECTOR_OP_KIND_MATCHES_OFFER;

const CONNECTOR_OP_APPROVED_ACTION = "connector.op_approved";

interface ConnectorOpArgs {
  readonly org: string;
  readonly scopeKey: string;
  /** The name the model called (the mounted name). The replay matches it. */
  readonly tool: string;
  /** The op's whole name when `tool` is a short name. The card and the audit row show it. */
  readonly op?: string;
  readonly connection: string;
  readonly grain: ConnectorOpCardOffer["grain"];
  readonly opTier?: ConnectorOpCardOffer["opTier"];
  readonly sessionKey: string;
  readonly memoKind: string;
  readonly inputPreview: string;
  readonly input?: Readonly<Record<string, unknown>>;
  readonly inputCleared?: true;
  readonly requestedBy: string;
  /** @deprecated Since OPE-2717 nothing writes or reads it. A card frozen before the deploy can still carry it; it is ignored. OPE-2721 removes it. */
  readonly tainted?: boolean;
  readonly credential?: "domain" | "personal";
}

export const ONE_CALL_APPROVAL_TTL_HOURS = 24;

/** The op the card names: its whole name, never a short name that hides the cut-off verb. */
function shownOp(args: ConnectorOpArgs): string {
  return args.op ?? args.tool;
}

function summarizeConnectorOp(args: ConnectorOpArgs): string[] {
  const tier = args.grain === "destructive" ? "destructive-tier " : "";
  return [
    `Run the ${tier}op "${shownOp(args)}" on connection "${args.connection}" — approves this one call, with exactly this input`,
    `Input: ${args.inputPreview}`,
  ];
}

const REPLAY_TARGET_SEGMENT = /^[A-Za-z0-9_.:-]{1,128}$/u;

function connectorReplayTarget(args: ConnectorOpArgs): { connection: string; tool: string } | undefined {
  if (args.input === undefined || args.input === null || typeof args.input !== "object") return undefined;
  // The replay names the tool the model called. A short name of a long connection starts with the
  // first characters of the connection, so the split falls back to the name's own first `__`.
  const own = args.tool.indexOf("__");
  const prefix = args.tool.startsWith(`${args.connection}__`) ? args.connection : own > 0 && args.connection.startsWith(args.tool.slice(0, own)) ? args.tool.slice(0, own) : undefined;
  if (prefix === undefined) return undefined;
  const tool = args.tool.slice(prefix.length + 2);
  if (!REPLAY_TARGET_SEGMENT.test(prefix) || !REPLAY_TARGET_SEGMENT.test(tool)) return undefined;
  return { connection: prefix, tool };
}

const connectorOp: ActionKind<ConnectorOpArgs> = {
  kind: CONNECTOR_OP_KIND,
  policy: "member",
  approvalArmsCall: true,
  armedCallReplay: (args) => connectorReplayTarget(args),
  argsAfterClose: (args) => connectorArgsWithoutInput(args),
  plainSummary: (args) =>
    // "Run " + op (70) + " once on " + connection (34) + the warning (33) fit in PLAIN_SUMMARY_MAX
    // (150), so the end cut of the headline never drops the destructive warning.
    `Run ${plainOpWords(toolWords(shownOp(args)), 70)} once on ${plainOpWords(args.connection, 34)}${args.grain === "destructive" ? " — this deletes or overwrites data" : ""}`,
  consequence: (args) => (args.inputPreview.trim().length > 0 ? `Input: ${plainQuote(args.inputPreview, QUOTE_MAX - 10)}` : undefined),
  consequenceQuotes: true,
  summarize: (args) => summarizeConnectorOp(args),
  async execute(args, decidedBy) {
    if (decidedBy.startsWith("chain:")) {
      await appendAudit({
        ...whereFromScope(args.org, args.scopeKey),
        principalId: args.requestedBy,
        action: CONNECTOR_OP_APPROVED_ACTION,
        detail: { connection: args.connection, op: shownOp(args), grain: args.grain, requestedBy: args.requestedBy, decidedBy },
      });
      return `${toolWords(shownOp(args))} runs this one call now`;
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
      detail: { connection: args.connection, op: shownOp(args), grain: args.grain, requestedBy: args.requestedBy },
    });
    return `${toolWords(shownOp(args))} may run once with this input`;
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
    ...(offer.op === undefined || offer.op === offer.tool ? {} : { op: offer.op }),
    connection: offer.connection,
    grain: offer.grain,
    ...(offer.opTier === undefined ? {} : { opTier: offer.opTier }),
    sessionKey: offer.sessionKey,
    memoKind: offer.memoKind,
    inputPreview: offer.inputPreview,
    ...(offer.input === undefined ? {} : { input: offer.input }),
    requestedBy: room.requestedBy,
    ...(offer.credential === undefined ? {} : { credential: offer.credential }),
  };
}

export async function offerConnectorCard(offer: ConnectorOpCardOffer, deps: { readonly request?: typeof requestApproval } = {}): Promise<ConnectorOpCardResult> {
  const surface = offer.auth === undefined || offer.auth === null ? null : await surfaceContextFromAuth(offer.auth as SessionAuth).catch(() => null);
  if (surface === null) return { outcome: "refused", reason: "this call names no conversation a card could be posted to" };
  const ctx = connectorCardContext(surface, offer.session);
  // principal-gate: presence — the card's "asked by" line is the approver's evidence; a turn with nobody acting has no card.
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
      chain: { unattended: unattendedOf(ctx), ...(domain === undefined ? {} : { domain }) },
    },
    approvalPostDeps(venue.platform, ctx),
  );
  if (posted.autoApproved) return { outcome: "approved" };
  return { outcome: "carded", pendingId: posted.id, where: venue.sameRoom ? "in this conversation" : `in ${placeWords({ key: venue.surfaceKey })}` };
}

registerConnectorOpCardOfferer((offer) => offerConnectorCard(offer));

export function signInCardText(offer: Pick<SignInCardOffer, "connector" | "url" | "resumes">): string {
  const vendor = connectorDisplayName(offer.connector);
  return (
    `🔐 To do this I need your own ${vendor} account, and it is not connected yet. ` +
    `Open this private link to connect it (it expires soon, so do not forward it): ${offer.url}\n` +
    (offer.resumes === true ? "Once you connect it, I pick the job up again. Nothing has run yet." : "Once you connect it, tell me here and I'll pick the job up. Nothing has run yet.")
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
    footer: dmDeliveryFooter({
      platform: offer.platform,
      recipientId: offer.recipientId,
      requestedBy: offer.recipientId,
      from: offer.fromContainer,
      ...(offer.sameConversation === true ? { sameConversation: true } : {}),
    }),
    requestedBy: offer.recipientId,
    attributedTo: offer.recipientId,
  });
  return true;
}

registerSignInCardDeliverer(deliverSignIn);
