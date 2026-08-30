import { canDeliverDirectMessage, postArm, type DirectMessageAction } from "../channels/post-arms.js";
import { editSurfaceText } from "../channels/surface-message-ops.js";
import { GRANT_STANDING_MAX_MS } from "./credential-grant.js";
import { quotedPurpose, type CredentialGrantAskRow, type CredentialGrantMode, type CredentialGrantRow } from "../operational/credential-grant-rows.js";

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

function grantModePhrase(mode: CredentialGrantMode): string {
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

export function grantCardText(ask: CredentialGrantAskRow, requesterLabel: string): string {
  return [
    `*${requesterLabel}* asks to use your ${ask.connector} credential.`,
    "",
    `• Tool: \`${quotedPurpose(ask.mcpTool ?? ask.verb)}\``,
    `• On: \`${ask.resource}\``,
    ...frozenLines(ask),
    ...(ask.toolName === undefined ? [] : [`• They would gain the tool: \`${ask.toolName}\``]),
    `• Where: this one conversation only`,
    `• They asked for: ${GRANT_MODE_WORDS[ask.requestedMode]}`,
    `• Their stated purpose: "${quotedPurpose(ask.purpose)}"`,
    "",
    "Tap one button to answer:",
    `• *Approve ${GRANT_MODE_WORDS.once}* — one call that actually reaches ${ask.connector}. An attempt blocked before it is sent costs nothing and can be retried — at most ${String(GRANT_ONCE_MAX_ATTEMPTS_PER_TURN)} attempts in one turn.`,
    `• *Approve for ${GRANT_MODE_WORDS.session}* — every call that conversation makes, until the grant expires.`,
    `• *Approve for ${GRANT_MODE_WORDS.standing}* — a standing grant, clamped to a fixed ${String(STANDING_DAYS)}-day ceiling.`,
    "• *Decline* — nothing is granted.",
    "",
    "A button is the only thing that can answer this. If the buttons are missing, or a tap seems to do nothing, nothing has been granted — the request then lapses on its own and they can raise a fresh one.",
    "Approving lets that conversation run this one tool on this one resource with your credential. It grants nothing else.",
  ].join("\n");
}

function frozenLines(ask: CredentialGrantAskRow): readonly string[] {
  const frozen = ask.frozenArgs;
  if (frozen === undefined) return [];
  const keys = Object.keys(frozen).sort();
  if (keys.length === 0) {
    return ["\u2022 Fixed arguments: none \u2014 that conversation chooses every argument this tool takes"];
  }
  const shown = keys.slice(0, FROZEN_KEYS_SHOWN);
  const lines = [
    `\u2022 Fixed arguments (${String(keys.length)}, and they cannot be changed):`,
    ...shown.map((key) => {
      const k = cardData(key, FROZEN_KEY_MAX);
      const name = k.truncated ? `\`${k.text}\` \u26a0\ufe0f (name truncated)` : `\`${k.text}\``;
      return `    \u00b7 ${name} = ${frozenValueLine(frozen[key])}`;
    }),
  ];
  if (keys.length > shown.length) {
    lines.push(
      `    \u00b7 \u26a0\ufe0f ${String(keys.length - shown.length)} more fixed argument(s) are NOT shown here. Decline unless you know exactly what this asks for.`,
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
    `• Tool: \`${quotedPurpose(ask.mcpTool ?? ask.verb)}\``,
    `• On: \`${ask.resource}\``,
    "",
    "Nothing was granted and nothing was spent. Tapping a button on this card now does nothing.",
    requesterNotified
      ? "The person who asked has been told the request lapsed, and they can ask again if they still need it."
      : "This deployment could not reach the conversation they asked from, so they have NOT been told — they may still be waiting on an answer.",
  ].join("\n");
}

export function refusedGrantCardText(ask: CredentialGrantAskRow, gate: GrantApproveGate): string {
  return [
    `🚫 NOT GRANTED — your ${ask.connector} account could not lend this.`,
    "",
    `• Tool: \`${quotedPurpose(ask.mcpTool ?? ask.verb)}\``,
    `• On: \`${ask.resource}\``,
    "",
    ask.mcpTool === undefined
      ? "This request was raised by an older build and this one cannot complete it. Nothing was granted and nothing was spent."
      : gate === "tool_absent"
        ? `Your ${ask.connector} connection does not publish a tool by that name, so there was nothing to lend. Nothing was granted and nothing was spent.`
        : `That request fixes arguments the ${ask.connector} tool does not take, so the grant could never have been spent. Nothing was granted and nothing was spent.`,
    "This request is closed. Ask them to raise a fresh one if it is still needed.",
  ].join("\n");
}

export type GrantApproveGate = "tool_absent" | "frozen_args_unknown";

export function approvedGrantCardText(ask: CredentialGrantAskRow, grant: Pick<CredentialGrantRow, "mode" | "expiresAt">): string {
  return [
    `✅ APPROVED — you approved this request.`,
    "",
    `• Tool: \`${quotedPurpose(ask.mcpTool ?? ask.verb)}\``,
    `• On: \`${ask.resource}\``,
    "",
    `You approved ${grantModePhrase(grant.mode)}, and it expires ${grant.expiresAt}.`,
    "Tapping a button on this card now does nothing.",
  ].join("\n");
}

export function declinedGrantCardText(ask: CredentialGrantAskRow): string {
  return [
    `🚫 DECLINED — you declined this request.`,
    "",
    `• Tool: \`${quotedPurpose(ask.mcpTool ?? ask.verb)}\``,
    `• On: \`${ask.resource}\``,
    "",
    "Nothing was granted and nothing was spent. Tapping a button on this card now does nothing.",
  ].join("\n");
}

export function grantConsentPromptText(ask: CredentialGrantAskRow, url: string): string {
  return [
    `Before that ${ask.connector} grant can be approved, connect your own ${ask.connector} account.`,
    "",
    `Open this link, then press Approve on the request again: ${url}`,
    "",
    "The link connects YOUR account only — do not forward it. Nothing has been granted and nothing has been spent.",
  ].join("\n");
}

export type GrantCardDelivery =
  | { readonly delivered: true; readonly surfaceId: string; readonly messageId: string }
  | { readonly delivered: false; readonly reason: "no_dm_arm" | "send_failed" };

export async function deliverGrantCard(ask: CredentialGrantAskRow, requesterLabel: string): Promise<GrantCardDelivery> {
  if (!canDeliverDirectMessage(ask.ownerPlatform)) return { delivered: false, reason: "no_dm_arm" };
  const arm = postArm(ask.ownerPlatform);
  const deliver = arm?.deliverDirectMessage;
  if (deliver === undefined || arm === undefined) return { delivered: false, reason: "no_dm_arm" };
  try {
    const landed = await deliver.call(arm, { actions: grantCardActions(ask), principalId: ask.ownerNativeId, text: grantCardText(ask, requesterLabel) });
    return { delivered: true, messageId: landed.messageId, surfaceId: landed.surfaceId };
  } catch {
    return { delivered: false, reason: "send_failed" };
  }
}

export async function expireGrantCard(ask: CredentialGrantAskRow, requesterNotified: boolean): Promise<boolean> {
  return await rewriteGrantCard(ask, expiredGrantCardText(ask, requesterNotified));
}

export async function refuseGrantCard(ask: CredentialGrantAskRow, gate: GrantApproveGate): Promise<boolean> {
  return await rewriteGrantCard(ask, refusedGrantCardText(ask, gate));
}

export async function approveGrantCard(ask: CredentialGrantAskRow, grant: Pick<CredentialGrantRow, "mode" | "expiresAt">): Promise<boolean> {
  return await rewriteGrantCard(ask, approvedGrantCardText(ask, grant));
}

export async function declineGrantCard(ask: CredentialGrantAskRow): Promise<boolean> {
  return await rewriteGrantCard(ask, declinedGrantCardText(ask));
}

async function rewriteGrantCard(ask: CredentialGrantAskRow, text: string): Promise<boolean> {
  if (ask.cardSurfaceId === undefined || ask.cardMessageId === undefined) return false;
  return await editSurfaceText(ask.ownerPlatform, { channelId: ask.cardSurfaceId, messageId: ask.cardMessageId }, text);
}

export async function deliverGrantConsentPrompt(ask: CredentialGrantAskRow, url: string): Promise<boolean> {
  if (!canDeliverDirectMessage(ask.ownerPlatform)) return false;
  const arm = postArm(ask.ownerPlatform);
  const deliver = arm?.deliverDirectMessage;
  if (deliver === undefined || arm === undefined) return false;
  try {
    await deliver.call(arm, { principalId: ask.ownerNativeId, text: grantConsentPromptText(ask, url) });
    return true;
  } catch {
    return false;
  }
}
