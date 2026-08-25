import { canDeliverDirectMessage, postArm, type DirectMessageAction } from "../channels/post-arms.js";
import { editSurfaceText } from "../channels/surface-message-ops.js";
import { GRANT_STANDING_MAX_MS } from "./credential-grant.js";
import { quotedPurpose, type CredentialGrantAskRow, type CredentialGrantMode } from "../operational/credential-grant-rows.js";

const STANDING_DAYS = Math.round(GRANT_STANDING_MAX_MS / (24 * 60 * 60 * 1000));

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

export function grantCardActions(ask: CredentialGrantAskRow): readonly DirectMessageAction[] {
  return [
    { id: grantCardActionId(ask.id, "once"), intent: "affirm", label: "Approve once" },
    { id: grantCardActionId(ask.id, "session"), intent: "affirm", label: "Approve for this conversation" },
    { id: grantCardActionId(ask.id, "standing"), intent: "affirm", label: `Approve for ${STANDING_DAYS} days` },
    { id: grantCardActionId(ask.id, "decline"), intent: "reject", label: "Decline" },
  ];
}

export function grantCardText(ask: CredentialGrantAskRow, requesterLabel: string): string {
  return [
    `*${requesterLabel}* asks to use your ${ask.connector} credential.`,
    "",
    `• Tool: \`${ask.verb}\``,
    `• Resource: \`${ask.resource}\``,
    `• Where: this one conversation only`,
    `• They asked for: ${modeWords(ask.requestedMode)}`,
    `• Their stated purpose: "${quotedPurpose(ask.purpose)}"`,
    "",
    `You can approve it once, for this conversation, or for ${STANDING_DAYS} days — or decline.`,
    "Reply `once`, `conversation`, `standing` or `no` if you cannot see the buttons.",
    "Approving lets that conversation run this one tool on this one resource with your credential. It grants nothing else.",
  ].join("\n");
}

function modeWords(mode: CredentialGrantMode): string {
  switch (mode) {
    case "once":
      return "one single call";
    case "session":
      return "this conversation";
    case "standing":
      return "a standing grant with an expiry";
  }
}

export function expiredGrantCardText(ask: CredentialGrantAskRow, requesterNotified: boolean): string {
  return [
    `⌛ EXPIRED — this request timed out.`,
    "",
    `• Tool: \`${ask.verb}\``,
    `• Resource: \`${ask.resource}\``,
    "",
    "Nothing was granted and nothing was spent. Tapping a button on this card now does nothing.",
    requesterNotified
      ? "The person who asked has been told the request lapsed, and they can ask again if they still need it."
      : "This deployment could not reach the conversation they asked from, so they have NOT been told — they may still be waiting on an answer.",
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
  if (ask.cardSurfaceId === undefined || ask.cardMessageId === undefined) return false;
  return await editSurfaceText(ask.ownerPlatform, { channelId: ask.cardSurfaceId, messageId: ask.cardMessageId }, expiredGrantCardText(ask, requesterNotified));
}
