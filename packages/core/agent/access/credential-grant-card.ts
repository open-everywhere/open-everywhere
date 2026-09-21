import { canDeliverDirectMessage, type DirectMessageAction } from "../channels/post-arms.js";
import {
  deliverProactiveDm,
  dmDeliveryFooter,
  personAddress,
  ProactiveDmRefusedError,
  type DmDeliveryWhere,
} from "../channels/dm-audience.js";
import { editSurfaceText } from "../channels/surface-message-ops.js";
import { GRANT_STANDING_MAX_MS } from "./credential-grant.js";
import { connectorDisplayName, grantActionIsReviewed, grantActionPhrase, grantConversationPhrase, grantExpiryPhrase, grantRequesterPhrase } from "./credential-grant-copy.js";
import {
  flatDisplayName,
  grantResourceTargetLabel,
  quotedPurpose,
  type CredentialGrantAskRow,
  type CredentialGrantMode,
  type CredentialGrantRow,
  type GrantJsonObject,
} from "../operational/credential-grant-rows.js";

const STANDING_DAYS = Math.round(GRANT_STANDING_MAX_MS / (24 * 60 * 60 * 1000));

export const GRANT_ONCE_MAX_ATTEMPTS_PER_TURN = 4;

export const GRANT_MODE_WORDS: Readonly<Record<CredentialGrantMode, string>> = {
  once: "once",
  session: "this conversation",
  standing: `${String(STANDING_DAYS)} days`,
};

const GRANT_MODE_BREADTH: Readonly<Record<CredentialGrantMode, number>> = { once: 0, session: 1, standing: 2 };

export function grantModeIsBroader(mode: CredentialGrantMode, thanMode: CredentialGrantMode): boolean {
  return GRANT_MODE_BREADTH[mode] > GRANT_MODE_BREADTH[thanMode];
}

export const OE_GRANT_ACTION_PREFIX = "oe_grant:";

export type GrantCardAnswer = CredentialGrantMode | "decline";

export function grantCardActionId(askId: string, answer: GrantCardAnswer): string {
  return `${OE_GRANT_ACTION_PREFIX}${answer}:${askId}`;
}

export function parseGrantCardActionId(raw: string | undefined): { readonly askId: string; readonly answer: GrantCardAnswer } | undefined {
  if (typeof raw !== "string" || !raw.startsWith(OE_GRANT_ACTION_PREFIX)) return undefined;
  const body = raw.slice(OE_GRANT_ACTION_PREFIX.length);
  const cut = body.indexOf(":");
  if (cut <= 0) return undefined;
  const answer = body.slice(0, cut);
  const askId = body.slice(cut + 1);
  if (askId.length === 0) return undefined;
  if (answer !== "once" && answer !== "session" && answer !== "standing" && answer !== "decline") return undefined;
  return { answer, askId };
}

export function grantModePhrase(mode: CredentialGrantMode): string {
  return mode === "once" ? GRANT_MODE_WORDS.once : `for ${GRANT_MODE_WORDS[mode]}`;
}

export function grantCardActions(ask: CredentialGrantAskRow): readonly DirectMessageAction[] {
  return [
    { id: grantCardActionId(ask.id, "once"), intent: "affirm", label: `Approve ${grantModePhrase("once")}` },
    { id: grantCardActionId(ask.id, "session"), intent: "affirm", label: `Approve ${grantModePhrase("session")}` },
    { id: grantCardActionId(ask.id, "standing"), intent: "affirm", label: `Approve ${grantModePhrase("standing")}` },
    { id: grantCardActionId(ask.id, "decline"), intent: "reject", label: "Decline" },
  ];
}

export interface GrantAskWorkerOrigin {
  readonly seatLabel: string;
}

export function grantCardText(ask: CredentialGrantAskRow, requesterLabel: string, workerOrigin?: GrantAskWorkerOrigin, conversationLabel?: string): string {
  const who = flatDisplayName(grantRequesterPhrase(requesterLabel));
  const seat = workerOrigin === undefined ? undefined : flatDisplayName(workerOrigin.seatLabel);
  const vendor = connectorDisplayName(ask.connector);
  const where = flatDisplayName(grantConversationPhrase(conversationLabel));
  const domainBound = typeof ask.domainScopeKey === "string" && ask.domainScopeKey.length > 0;
  return [
    `*${seat ?? who}* asks to use your ${vendor} account, for ${where}.`,
    "",
    ...(workerOrigin === undefined
      ? []
      : [
          `• Who it is for: ${who}, in their conversation with ${seat}.`,
          `• How it was raised: ${seat} gave the work to a background task, and the task raised this ask. The task ends when its work does, and it never sees your answer.`,
          `• What a grant reaches: that conversation, never the background task.`,
          "",
        ]),
    askActionSentence(ask, "want"),
    `Their reason: "${quotedPurpose(ask.purpose)}"`,
    ...unreviewedToolLines(ask),
    ...frozenLines(ask),
    `They asked for: ${GRANT_MODE_WORDS[ask.requestedMode]}. You choose the answer.`,
    "",
    "Tap one button to answer:",
    `• *Approve ${GRANT_MODE_WORDS.once}* — one call that actually reaches ${vendor}. An attempt blocked before it is sent costs nothing and can be retried — at most ${String(GRANT_ONCE_MAX_ATTEMPTS_PER_TURN)} attempts in one turn.`,
    `• *Approve for ${GRANT_MODE_WORDS.session}* — every call that conversation makes, until the grant expires.`,
    domainBound
      ? `• *Approve for ${GRANT_MODE_WORDS.standing}* — the main conversation of this room and of the rooms declared into this room's domain, for ${String(STANDING_DAYS)} days. Wider than the two above: those other rooms can spend it too, for this one tool with the values below. It does NOT reach a thread of those rooms, and no scheduled run can spend it — a person has to be here asking.`
      : `• *Approve for ${GRANT_MODE_WORDS.standing}* — this one conversation, for ${String(STANDING_DAYS)} days. Wider than the two above only in TIME: no other room and no thread gets it, and no scheduled run can spend it — a person has to be here asking.`,
    "• *Decline* — nothing is granted.",
    "",
    "A button is the only thing that can answer this. If the buttons are missing, or a tap seems to do nothing, nothing has been granted — the request then lapses on its own and they can raise a fresh one.",
    closingReassurance(ask, where, vendor, domainBound),
  ].join("\n");
}

function askActionSentence(ask: CredentialGrantAskRow, lead: "want" | "wanted"): string {
  const opening = lead === "want" ? "They want to" : "They asked to";
  return `${opening} ${grantBorrowPhrase(ask)}.`;
}

export function grantBorrowPhrase(row: {
  readonly connector: string;
  readonly mcpTool?: string;
  readonly resource: string;
  readonly frozenArgs?: GrantJsonObject;
}): string {
  const action = grantActionPhrase(row.connector, row.mcpTool);
  const target = grantResourceTargetLabel(row);
  return target === undefined ? action : `${action} — "${quotedPurpose(target)}"`;
}

function closingReassurance(ask: CredentialGrantAskRow, where: string, vendor: string, domainBound: boolean): string {
  const action = grantActionPhrase(ask.connector, ask.mcpTool);
  const pinned = Object.keys(ask.frozenArgs ?? {}).length > 0;
  const reach = domainBound
    ? "Only the main conversation of the asker's room and of the rooms declared into its domain can spend it"
    : "Only the conversation they asked from can spend it";
  const bound = `Whichever button you press, this lends ONE thing: your ${vendor} account doing that one job, and nothing else you can reach in ${vendor}. ${reach}, only while somebody is there asking, and only until it ends.`;
  return pinned
    ? `Approving lets ${where} ${action} with your account — the pinned values above, and nothing else in ${vendor}. ${bound}`
    : `Approving lets ${where} ${action} with your account, choosing for itself which one, every time. Nothing is pinned, so this reaches whatever that tool can read in your ${vendor} account. ${bound}`;
}

function unreviewedToolLines(ask: CredentialGrantAskRow): readonly string[] {
  if (grantActionIsReviewed(ask.connector, ask.mcpTool)) return [];
  return [
    `⚠️ This deployment has no plain description of what they asked for. It can only READ — a write is refused before any card is ever sent — but exactly what it reads in ${connectorDisplayName(ask.connector)} is decided by the pinned values on the next line. Read them, and decline unless you know what this is.`,
  ];
}

function frozenLines(ask: CredentialGrantAskRow): readonly string[] {
  const frozen = ask.frozenArgs;
  if (frozen === undefined) return [];
  const keys = Object.keys(frozen).sort();
  if (keys.length === 0) {
    return ["Nothing is pinned down: that conversation would choose every detail of the call, which is a wider ask than pinning one thing."];
  }
  const shown = keys.slice(0, FROZEN_KEYS_SHOWN);
  const lines = [
    keys.length === 1 ? "It is pinned to this one value, which they cannot change:" : `It is pinned to these ${String(keys.length)} values, which they cannot change:`,
    ...shown.map((key) => {
      const k = cardData(key, FROZEN_KEY_MAX);
      const name = k.truncated ? `\`${k.text}\` \u26a0\ufe0f (name truncated)` : `\`${k.text}\``;
      return `    \u00b7 ${name} = ${frozenValueLine(frozen[key])}`;
    }),
  ];
  if (keys.length > shown.length) {
    lines.push(
      `    \u00b7 \u26a0\ufe0f ${String(keys.length - shown.length)} more pinned value(s) are NOT shown here. Decline unless you know exactly what this asks for.`,
    );
  }
  return lines;
}

const FROZEN_KEYS_SHOWN = 25;
const FROZEN_VALUE_MAX = 120;
const FROZEN_KEY_MAX = 60;

function frozenValueLine(value: unknown): string {
  const rendered = cardData(JSON.stringify(value) ?? "null", FROZEN_VALUE_MAX);
  return rendered.truncated
    ? `\`${rendered.text}\` \u26a0\ufe0f (value truncated \u2014 the grant fixes the FULL value, which is longer than this)`
    : `\`${rendered.text}\``;
}

function cardData(raw: string, max: number): { readonly text: string; readonly truncated: boolean } {
  const flat = raw.replace(/[\r\n]+/gu, " ").replace(/["'`]/gu, "").trim();
  return flat.length > max ? { text: flat.slice(0, max), truncated: true } : { text: flat, truncated: false };
}

export function expiredGrantCardText(ask: CredentialGrantAskRow, requesterNotified: boolean): string {
  return [
    `⌛ EXPIRED — this request timed out.`,
    "",
    askActionSentence(ask, "wanted"),
    "",
    "Nothing was granted and nothing was spent. Tapping a button on this card now does nothing.",
    requesterNotified
      ? "The person who asked has been told the request lapsed, and they can ask again if they still need it."
      : "This deployment could not reach the conversation they asked from, so they have NOT been told — they may still be waiting on an answer.",
  ].join("\n");
}

export function refusedGrantCardText(ask: CredentialGrantAskRow, gate: GrantApproveGate): string {
  const vendor = connectorDisplayName(ask.connector);
  return [
    `🚫 NOT GRANTED — your ${vendor} account could not lend this.`,
    "",
    askActionSentence(ask, "wanted"),
    "",
    ask.mcpTool === undefined
      ? "This request was raised by an older build and this one cannot complete it. Nothing was granted and nothing was spent."
      : gate === "tool_absent"
        ? `Your ${vendor} account does not offer what they asked for, so there was nothing to lend. Nothing was granted and nothing was spent.`
        : `That request pins values the ${vendor} tool does not take, so the grant could never have been spent. Nothing was granted and nothing was spent.`,
    "This request is closed. Ask them to raise a fresh one if it is still needed.",
  ].join("\n");
}

export type GrantApproveGate = "tool_absent" | "frozen_args_unknown";

export function approvedGrantCardText(ask: CredentialGrantAskRow, grant: Pick<CredentialGrantRow, "mode" | "expiresAt">, nowMs: number): string {
  return [
    `✅ APPROVED — you approved this request.`,
    "",
    askActionSentence(ask, "wanted"),
    "",
    `You approved ${grantModePhrase(grant.mode)}, ${grantExpiryPhrase(grant.expiresAt, nowMs)}.`,
    "Tapping a button on this card now does nothing.",
  ].join("\n");
}

export function declinedGrantCardText(ask: CredentialGrantAskRow): string {
  return [
    `🚫 DECLINED — you declined this request.`,
    "",
    askActionSentence(ask, "wanted"),
    "",
    "Nothing was granted and nothing was spent. Tapping a button on this card now does nothing.",
  ].join("\n");
}

export function grantConsentPromptText(ask: CredentialGrantAskRow, url: string): string {
  const vendor = connectorDisplayName(ask.connector);
  return [
    `You need to connect your ${vendor} account first.`,
    "",
    "Open this link (it connects your account only, do not forward it), then press Approve again:",
    url,
    "",
    "Nothing has been granted and nothing has been spent.",
  ].join("\n");
}

export type GrantCardRefusal = "no_dm_arm" | "send_failed" | "owner_stopped_dms" | "owner_dm_unreadable";

export type GrantCardDelivery =
  | { readonly delivered: true; readonly surfaceId: string; readonly messageId: string }
  | { readonly delivered: false; readonly reason: GrantCardRefusal };

export function grantOwnerDmAddress(ask: Pick<CredentialGrantAskRow, "ownerPlatform" | "ownerNativeId">): string {
  return personAddress(ask.ownerPlatform, ask.ownerNativeId);
}

function grantDmFooter(ask: CredentialGrantAskRow): string {
  return dmDeliveryFooter({ requestedBy: ask.requesterPrincipalId, fromContainer: ask.scopeKey });
}

function grantDmRefusal(err: unknown): GrantCardRefusal {
  if (!(err instanceof ProactiveDmRefusedError)) return "send_failed";
  return err.boundary === "stopped" ? "owner_stopped_dms" : "owner_dm_unreadable";
}

export async function deliverGrantCard(
  ask: CredentialGrantAskRow,
  where: DmDeliveryWhere,
  requesterLabel: string,
  workerOrigin?: GrantAskWorkerOrigin,
  conversationLabel?: string,
): Promise<GrantCardDelivery> {
  if (!canDeliverDirectMessage(ask.ownerPlatform)) return { delivered: false, reason: "no_dm_arm" };
  try {
    const landed = await deliverProactiveDm({
      where,
      plane: "credential.grant.card",
      platform: ask.ownerPlatform,
      recipientId: ask.ownerNativeId,
      address: grantOwnerDmAddress(ask),
      text: grantCardText(ask, requesterLabel, workerOrigin, conversationLabel),
      footer: grantDmFooter(ask),
      requestedBy: ask.requesterPrincipalId,
      attributedTo: ask.requesterPrincipalId,
      actions: grantCardActions(ask),
    });
    return { delivered: true, messageId: landed.messageId, surfaceId: landed.surfaceId };
  } catch (err) {
    return { delivered: false, reason: grantDmRefusal(err) };
  }
}

export async function expireGrantCard(ask: CredentialGrantAskRow, requesterNotified: boolean): Promise<boolean> {
  return await rewriteGrantCard(ask, expiredGrantCardText(ask, requesterNotified));
}

export async function refuseGrantCard(ask: CredentialGrantAskRow, gate: GrantApproveGate): Promise<boolean> {
  return await rewriteGrantCard(ask, refusedGrantCardText(ask, gate));
}

export async function approveGrantCard(ask: CredentialGrantAskRow, grant: Pick<CredentialGrantRow, "mode" | "expiresAt">, nowMs: number): Promise<boolean> {
  return await rewriteGrantCard(ask, approvedGrantCardText(ask, grant, nowMs));
}

export async function declineGrantCard(ask: CredentialGrantAskRow): Promise<boolean> {
  return await rewriteGrantCard(ask, declinedGrantCardText(ask));
}

async function rewriteGrantCard(ask: CredentialGrantAskRow, text: string): Promise<boolean> {
  if (ask.cardSurfaceId === undefined || ask.cardMessageId === undefined) return false;
  return await editSurfaceText(ask.ownerPlatform, { channelId: ask.cardSurfaceId, messageId: ask.cardMessageId }, text);
}

export async function deliverGrantConsentPrompt(ask: CredentialGrantAskRow, where: DmDeliveryWhere, url: string): Promise<boolean> {
  if (!canDeliverDirectMessage(ask.ownerPlatform)) return false;
  try {
    await deliverProactiveDm({
      where,
      plane: "credential.grant.consent",
      platform: ask.ownerPlatform,
      recipientId: ask.ownerNativeId,
      address: grantOwnerDmAddress(ask),
      text: grantConsentPromptText(ask, url),
      footer: grantDmFooter(ask),
      requestedBy: ask.requesterPrincipalId,
      attributedTo: ask.requesterPrincipalId,
    });
    return true;
  } catch {
    return false;
  }
}
