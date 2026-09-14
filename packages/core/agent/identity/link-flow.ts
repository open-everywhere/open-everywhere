import { hashLinkCode } from "./link-challenge.js";

export type LinkTransport = "directory" | "code";

export function asLinkTransport(raw: string | undefined): LinkTransport {
  return raw === "directory" ? "directory" : "code";
}

export type CodeBackDecision = { readonly mint: true } | { readonly mint: false; readonly reason: "not-required" | "undeliverable" };

export function codeBackDecision(input: { readonly transport: LinkTransport; readonly knobArmed: boolean; readonly deliverable: boolean }): CodeBackDecision {
  const required = input.transport === "code" || input.knobArmed;
  if (!required) return { mint: false, reason: "not-required" };
  return input.deliverable ? { mint: true } : { mint: false, reason: "undeliverable" };
}

export type FinalizeVerdict = { readonly kind: "peek" } | { readonly kind: "commit" } | { readonly kind: "refuse"; readonly reason: string };

export function finalizeGate(input: {
  readonly backNonceHash: string | undefined;
  readonly acknowledge?: boolean;
  readonly code?: string;
  readonly challengeId?: string;
}): FinalizeVerdict {
  const code = typeof input.code === "string" && input.code.trim().length > 0 ? input.code.trim() : undefined;
  const acknowledged = input.acknowledge === true;
  if (!acknowledged && code === undefined) return { kind: "peek" };
  if (input.challengeId === undefined) {
    return {
      kind: "refuse",
      reason:
        "a finalizing confirm must pass back the challengeId of the consent it acts on — call confirm_link with neither `acknowledge` nor `code` first: it names the waiting account and returns the challengeId.",
    };
  }
  if (input.backNonceHash !== undefined) {
    if (code === undefined) {
      return {
        kind: "refuse",
        reason:
          "this link needs the code I posted back to the other account — `acknowledge` alone does not finalize it. " +
          "If you ALREADY have that code, call again NOW with it and this challengeId: both calls belong in one turn, " +
          "and the person often gives you the code in the very message you are answering. Ask them to read it off the " +
          "other account only when you do not have it.",
      };
    }
    if (hashLinkCode(code) !== input.backNonceHash) {
      return { kind: "refuse", reason: "that code does not match the one I posted to the other account. Ask for it again — it is single-use and expires with the request." };
    }
    return { kind: "commit" };
  }
  if (code !== undefined) {
    return { kind: "refuse", reason: "no second code was issued for this request — finalize it with `acknowledge: true` once the person has confirmed the account is theirs." };
  }
  return { kind: "commit" };
}

export function consentGate(input: { readonly acknowledge?: boolean; readonly challengeId?: string; readonly code?: string }): FinalizeVerdict {
  if (typeof input.code === "string" && input.code.trim().length > 0) {
    return { kind: "refuse", reason: "there is no code to give me here — a second code, if this link needs one, goes to the person who asked. Confirm with `acknowledge: true` and the challengeId." };
  }
  if (input.acknowledge !== true) return { kind: "peek" };
  if (input.challengeId === undefined) {
    return {
      kind: "refuse",
      reason:
        "a consent must pass back the challengeId of the request it answers — call confirm_link without `acknowledge` first: it names the person who asked and returns the challengeId.",
    };
  }
  return { kind: "commit" };
}

export function claimVenueRefusal(input: { readonly dmCapable: boolean; readonly mode: string | undefined }): string | undefined {
  if (!input.dmCapable) return undefined;
  if (input.mode === "dm") return undefined;
  return (
    "I can't take a link code here — a code is a secret for as long as it lasts, and this conversation has " +
    "an audience. DM me and send it there instead. The code is still good; nothing was used up."
  );
}

export function claimAddressingRefusal(input: { readonly addressed: boolean }): string | undefined {
  if (input.addressed) return undefined;
  return (
    "I can't take a link code from a line that isn't addressed to me — anybody can type in here, so a " +
    "bare line is not evidence you meant it for me. Send the same line again, addressed to me: " +
    "@mention me, or name-drop me where I have no @mention. The code is still good; nothing was used up."
  );
}

export function linkConsentPendingInstructions(targetName: string, ttlMinutes: number): string {
  return (
    `I have asked ${targetName} to confirm, in their own DM with me, that the account is theirs. ` +
    `Nothing is linked yet, and nothing will be until you finalize it here.\n\n` +
    `The request expires in ${ttlMinutes} minutes. When they answer I will come back to you in this ` +
    `conversation. If you did not expect to be asked about that account, do nothing — a request that ` +
    `is never finalized writes nothing at all.`
  );
}

export function linkConsentAsk(input: {
  readonly initiatorAnchor: string;
  readonly initiatorName?: string;
  readonly targetAnchor: string;
  readonly ttlMinutes: number;
}): string {
  const attributed = input.initiatorName
    ? `\n\nThat account calls itself "${input.initiatorName}". That is a name the account sets for ` +
      `itself, so read it as a claim rather than as something I checked — the account id above is the ` +
      `part nobody can change.`
    : "";
  return (
    `Somebody asked me to link your account to theirs, and I need your say-so first.\n\n` +
    `Who asked: ${input.initiatorAnchor}\n` +
    `Your account: ${input.targetAnchor}${attributed}\n\n` +
    `Linking means the two accounts count as ONE PERSON everywhere I can see, so their work and yours ` +
    `are attributed together.\n\n` +
    `If that account is yours, tell me here and I will record your consent. If you do not recognise it, ` +
    `tell me to deny it. Nothing is written unless you agree, and the request expires on its own in ` +
    `${input.ttlMinutes} minutes if you ignore it.`
  );
}

export function linkConsentButtonLabels(): { readonly confirm: string; readonly deny: string } {
  return { confirm: "Yes — that account is mine", deny: "No — I don't recognise this" };
}

export function linkConsentClickAnswers(): {
  readonly consented: string;
  readonly consentedWithCode: (code: string) => string;
  readonly denied: string;
  readonly notYours: string;
  readonly gone: string;
} {
  return {
    consented:
      "Recorded — thank you. NOTHING IS LINKED YET: the person who asked still has to finish it on " +
      "their side, and I have told them you agreed. If you did not mean to do that, tell me here and " +
      "I will take it back.",
    consentedWithCode: (code: string) =>
      `Recorded — thank you. Nothing is linked yet. To finish, the person who asked has to prove they ` +
      `can read this conversation, so give them this code and let them enter it where they started the ` +
      `link:\n\n    ${code}\n\nIt is single-use and expires with the request.`,
    denied: "Declined. Nothing was written and nothing was linked, and that request is now closed for good.",
    notYours:
      "I have no open request for you to answer here. It was either already decided, or it has expired " +
      "on its own. Nothing was written either way.",
    gone: "That request is no longer open — it was already answered, or it expired. Nothing was written.",
  };
}

export function codeBackInstructions(code: string): string {
  return (
    `Consent recorded. To finish, the person who asked has to prove they can read this conversation, ` +
    `so give them this code and let them enter it where they started the link:\n\n    ${code}\n\n` +
    `It is single-use and expires with the request. Nothing is linked until they enter it.`
  );
}

export function claimCodeBackReply(code: string): string {
  return (
    `That is a good code — I have recorded that this account is claiming the link. One step left: ` +
    `whoever started the link has to prove they can read this, so enter this code where they started it:\n\n    ${code}\n\n` +
    `It is single-use and expires with the request. Nothing is linked until it is entered.`
  );
}
