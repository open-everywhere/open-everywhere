import { defineHook } from "eve/hooks";
import { bindFrom, type BindableContext } from "../identity/binding.js";
import { actingPrincipalId, currentTurnAddressed, currentTurnBotName } from "../identity/binding.js";
import { detectLinkClaim, detectAddressedLinkClaim } from "../identity/link-challenge.js";
import { agentNameTokens } from "../identity/bot-name.js";
import { claimLinkChallenge } from "../identity/link-store.js";
import { linkTenantOf } from "../identity/link-tenant.js";
import { canDeliverDirectMessage, dispatchDirectMessage } from "../channels/post-arms.js";
import { postReply, resolveReplyTarget } from "../channels/reply-post.js";
import { BINDING_TRUSTED_PLATFORMS } from "../memory/domain.js";
import { tryPrincipalKey } from "../identity/principal-key.js";
import type { WakeTrust } from "../channels/wake-envelope.js";

function isEnvelopeShaped(text: string): boolean {
  if (/<wake\b/i.test(text)) return true;
  const authorMarkers = text.match(/\bauthor-id=/gi);
  return (authorMarkers?.length ?? 0) >= 1 || (text.match(/<message\b/gi)?.length ?? 0) >= 1;
}

function log(line: string): void {
  console.log(`[open-everywhere:identity] ${line}`);
}

async function notify(arm: ((text: string) => Promise<void> | void) | undefined, text: string): Promise<void> {
  if (!arm) return;
  try {
    await arm(text);
  } catch (err) {
    log(`link claim refusal notice could not be delivered: ${String(err)}`);
  }
}

export async function observeLinkClaim(input: {
  readonly org: string;
  readonly platform: string;
  readonly tenant?: string;
  readonly authorId: string | undefined;
  readonly text: string | undefined;
  readonly addressed?: boolean;
  readonly addressTokens?: readonly string[];
  readonly trust?: WakeTrust;
  readonly trustIsEvidence?: boolean;
  readonly notifyRefusal?: (text: string) => Promise<void> | void;
  readonly now?: Date;
}): Promise<string | undefined> {
  const code = input.addressed
    ? detectAddressedLinkClaim(input.text, input.addressTokens ?? [])
    : detectLinkClaim(input.text);
  if (!code) return undefined;
  if (input.text && isEnvelopeShaped(input.text)) {
    log("link claim seen in envelope-shaped text (multiple authors) — ignored (a claim's code and its claimant must come from ONE message).");
    return undefined;
  }
  if (!input.authorId) {
    log("link claim seen with no captured author id — ignored (a claim is only ever as good as the author the surface resolved).");
    return undefined;
  }
  const tierClaims = input.trust === "peer" || input.trust === "principal";
  const tierIsEvidence = input.trustIsEvidence !== false;
  if (!tierClaims && (input.trust === "relay" || input.trust === undefined || tierIsEvidence)) {
    log(`link claim from a non-vouched author (trust=${input.trust ?? "unknown"}) — ignored (only an identified internal human may claim on this surface).`);
    if (input.trust === "unauth") {
      await notify(
        input.notifyRefusal,
        `I can't accept a link claim from here — I can't confirm this surface is inside your organization, ` +
          `so I can't vouch that you are the person that code was issued to. Try again from a surface I've ` +
          `confirmed, or DM me.`,
      );
    }
    return undefined;
  }
  const claimed = await claimLinkChallenge({
    org: input.org,
    code,
    claimant: { platform: input.platform, tenant: linkTenantOf(input.platform, input.tenant), nativeId: input.authorId },
    ...(input.now ? { now: input.now } : {}),
  });
  if (!claimed) {
    log("link claim matched a code that could not be claimed (spent, expired, self-claimed or unknown) — ignored.");
    await notify(
      input.notifyRefusal,
      `That link code didn't work — it may have expired, already been used, or been sent from the same ` +
        `account that asked for it. Ask me to link again from your other account and I'll issue a fresh one.`,
    );
    return undefined;
  }

  const claimant =
    tryPrincipalKey(input.platform, claimed.claimedTenant ?? input.tenant, input.authorId) ??
    `the ${input.platform} account "${input.authorId}"`;
  if (canDeliverDirectMessage(claimed.initiatingPlatform)) {
    try {
      await dispatchDirectMessage(claimed.initiatingPlatform, {
        principalId: claimed.initiatingNativeId,
        text:
          `**${claimant}** just claimed your link code.\n\n` +
          `If that is you, reply here to confirm and I will link the two accounts. If you do not ` +
          `recognise it, tell me to deny it — nothing is written until you say so.`,
      });
    } catch (err) {
      log(`link claim ${claimed.id} recorded, but the confirmation notice could not be delivered: ${String(err)}`);
    }
  }
  log(`link claim recorded: ${claimant} claimed challenge ${claimed.id} — awaiting the initiator's confirmation.`);
  return claimed.id;
}

export default defineHook({
  events: {
    "message.received": async (event, ctx) => {
      const raw = (event as { data?: { message?: unknown } }).data?.message;
      if (typeof raw !== "string") return;
      const addressed = currentTurnAddressed(ctx as BindableContext);
      const addressTokens = addressed ? agentNameTokens(currentTurnBotName(ctx as BindableContext)) : [];
      const preCode = addressed ? detectAddressedLinkClaim(raw, addressTokens) : detectLinkClaim(raw);
      if (!preCode) return;
      try {
        const binding = bindFrom(ctx as BindableContext);
        const authorId = actingPrincipalId(binding);
        const trust: WakeTrust = authorId === undefined ? "relay" : binding.trust === "internal" ? "peer" : "unauth";
        const trustIsEvidence = BINDING_TRUSTED_PLATFORMS.has(binding.platform);
        await observeLinkClaim({
          org: binding.org,
          platform: binding.platform,
          tenant: binding.workspace,
          authorId,
          text: raw,
          addressed,
          addressTokens,
          trust,
          trustIsEvidence,
          notifyRefusal: async (text) => {
            const target = resolveReplyTarget(ctx as BindableContext);
            if (!target) return;
            await postReply(target, text);
          },
        });
      } catch (err) {
        log(`link claim check skipped: ${String(err)}`);
      }
    },
  },
});
