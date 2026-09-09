import { appendAudit } from "../audit/audit.js";
import { canDeliverDirectMessage, dispatchDirectMessage, type DirectMessageAction } from "../channels/post-arms.js";
import { getOperationalStore } from "../operational/provider.js";
import { humanAccountLabel } from "./account-display-name.js";
import { mintLinkCode } from "./link-challenge.js";
import { asLinkTransport, codeBackDecision, linkConsentButtonLabels, linkConsentClickAnswers } from "./link-flow.js";
import { consentLinkChallenge, denyLinkChallenge, type LinkChallengeRow } from "./link-store.js";
import { getSettings } from "../settings/settings.js";

export interface ConsentingAccount {
  readonly platform: string;
  readonly tenant: string;
  readonly nativeId: string;
}

export async function commitLinkConsent(input: {
  readonly org: string;
  readonly challenge: LinkChallengeRow;
  readonly consenter: ConsentingAccount;
  readonly deliverable: boolean;
}): Promise<{ readonly codeBack?: string }> {
  const c = input.challenge;
  const decision = codeBackDecision({
    transport: asLinkTransport(c.transport),
    knobArmed: getSettings().identityLinking.codeBack,
    deliverable: input.deliverable,
  });
  const backCode = decision.mint ? mintLinkCode() : undefined;
  const consented = await consentLinkChallenge({
    org: input.org,
    challengeId: c.id,
    consenter: input.consenter,
    ...(backCode ? { backCode } : {}),
  });
  if (!consented) throw new Error("that request is no longer open — it was already answered, or it expired. Ask them to start it again.");

  if (canDeliverDirectMessage(c.initiatingPlatform)) {
    const consenterName = await humanAccountLabel(input.consenter.platform, input.consenter.nativeId, input.consenter.tenant);
    await dispatchDirectMessage(c.initiatingPlatform, {
      principalId: c.initiatingNativeId,
      text:
        `${consenterName} agreed to the link you asked for.\n\n` +
        (backCode
          ? `Ask them for the code I gave them and tell me here to finish it. Nothing is linked until you do.`
          : `Tell me here to finish it. Nothing is linked until you do.`),
    }).catch((err: unknown) => console.log(`[open-everywhere:identity] consent notice for ${c.id} could not be delivered: ${String(err)}`));
  }

  return backCode ? { codeBack: backCode } : {};
}

export const LINK_CONSENT_CLICK_PREFIX = "oe-link:";

export type LinkConsentVerdict = "confirm" | "deny";

const LINK_CONSENT_CLICK_ID_MAX = 100;

export function linkConsentClickId(challengeId: string, verdict: LinkConsentVerdict): string {
  const id = `${LINK_CONSENT_CLICK_PREFIX}${challengeId}:${verdict}`;
  if (id.length > LINK_CONSENT_CLICK_ID_MAX) {
    throw new Error(`link consent button id is ${id.length} characters and the cap is ${LINK_CONSENT_CLICK_ID_MAX}`);
  }
  return id;
}

export function parseLinkConsentClickId(raw: string | undefined): { readonly challengeId: string; readonly verdict: LinkConsentVerdict } | undefined {
  if (typeof raw !== "string" || !raw.startsWith(LINK_CONSENT_CLICK_PREFIX)) return undefined;
  const body = raw.slice(LINK_CONSENT_CLICK_PREFIX.length);
  const cut = body.lastIndexOf(":");
  if (cut <= 0) return undefined;
  const challengeId = body.slice(0, cut);
  const verdict = body.slice(cut + 1);
  if (challengeId.length === 0) return undefined;
  if (verdict !== "confirm" && verdict !== "deny") return undefined;
  return { challengeId, verdict };
}

export function linkConsentActions(challengeId: string): readonly DirectMessageAction[] {
  const labels = linkConsentButtonLabels();
  try {
    return [
      { id: linkConsentClickId(challengeId, "confirm"), label: labels.confirm, intent: "affirm" },
      { id: linkConsentClickId(challengeId, "deny"), label: labels.deny, intent: "reject" },
    ];
  } catch {
    return [];
  }
}

export const LINK_CONSENT_CLICK_ACTION = "identity.link.consent_click";

export interface LinkConsentClickResult {
  readonly outcome: "consented" | "denied" | "not-yours" | "gone";
  readonly text: string;
}

export async function resolveLinkConsentClick(input: {
  readonly org: string;
  readonly challengeId: string;
  readonly verdict: LinkConsentVerdict;
  readonly clicker: ConsentingAccount;
}): Promise<LinkConsentClickResult> {
  const answers = linkConsentClickAnswers();
  try {
    const store = getOperationalStore();
    await store.expireLinkChallenges(input.org, new Date().toISOString());
    const pending = await store.listLinkChallenges(input.org, {
      targetPlatform: input.clicker.platform,
      targetTenant: input.clicker.tenant,
      targetNativeId: input.clicker.nativeId,
      status: "pending",
    });
    const challenge = pending.find((c) => c.id === input.challengeId);
    if (!challenge) {
      await noteClick(input, "not-yours");
      return { outcome: "not-yours", text: answers.notYours };
    }

    if (input.verdict === "deny") {
      const denied = await denyLinkChallenge({ org: input.org, challengeId: challenge.id, from: ["pending"] });
      await noteClick(input, denied ? "denied" : "gone");
      return denied ? { outcome: "denied", text: answers.denied } : { outcome: "gone", text: answers.gone };
    }

    const { codeBack } = await commitLinkConsent({ org: input.org, challenge, consenter: input.clicker, deliverable: true });
    await noteClick(input, "consented");
    return { outcome: "consented", text: codeBack ? answers.consentedWithCode(codeBack) : answers.consented };
  } catch (err) {
    console.log(`[open-everywhere:identity] consent click for ${input.challengeId} did not resolve: ${String(err)}`);
    return { outcome: "gone", text: answers.gone };
  }
}

async function noteClick(input: { readonly org: string; readonly challengeId: string; readonly verdict: LinkConsentVerdict; readonly clicker: ConsentingAccount }, outcome: string): Promise<void> {
  try {
    await appendAudit({
      org: input.org,
      platform: input.clicker.platform,
      workspace: input.clicker.tenant || "unknown",
      action: LINK_CONSENT_CLICK_ACTION,
      detail: { challengeId: input.challengeId, verdict: input.verdict, outcome, clicker: input.clicker.nativeId },
    });
  } catch (err) {
    console.warn(`[open-everywhere:audit] ${LINK_CONSENT_CLICK_ACTION} row was not written: ${String(err)}`);
  }
}
