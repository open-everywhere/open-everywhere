import { canDeliverDirectMessage, postArm, type DirectMessageAction } from "../channels/post-arms.js";
import { quotedPurpose, type CredentialGrantAskRow, type CredentialGrantMode } from "../operational/credential-grant-rows.js";

export function grantCardActionId(askId: string, answer: CredentialGrantMode | "decline"): string {
  return `grant:${answer}:${askId}`;
}

export function grantCardActions(ask: CredentialGrantAskRow): readonly DirectMessageAction[] {
  return [
    { id: grantCardActionId(ask.id, "once"), intent: "affirm", label: "Approve once" },
    { id: grantCardActionId(ask.id, "session"), intent: "affirm", label: "Approve for this conversation" },
    { id: grantCardActionId(ask.id, "standing"), intent: "affirm", label: "Approve until it expires" },
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
    "You can approve it once, for this conversation, or until it expires — or decline.",
    "Reply `once`, `conversation`, `until expiry` or `no` if you cannot see the buttons.",
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
