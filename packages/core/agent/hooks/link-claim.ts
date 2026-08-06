import { defineHook } from "eve/hooks";
import { bindFrom, type BindableContext } from "../identity/binding.js";
import { actingPrincipalId } from "../identity/binding.js";
import { detectLinkClaim } from "../identity/link-challenge.js";
import { claimLinkChallenge } from "../identity/link-store.js";
import { canDeliverDirectMessage, dispatchDirectMessage } from "../channels/post-arms.js";
import { principalKey } from "../identity/principal-key.js";
import type { WakeTrust } from "../channels/wake-envelope.js";

function isEnvelopeShaped(text: string): boolean {
  if (/<wake\b/i.test(text)) return true;
  const authorMarkers = text.match(/\bauthor-id=/gi);
  return (authorMarkers?.length ?? 0) >= 1 || (text.match(/<message\b/gi)?.length ?? 0) >= 1;
}

function log(line: string): void {
  console.log(`[open-everywhere:identity] ${line}`);
}

export async function observeLinkClaim(input: {
  readonly org: string;
  readonly platform: string;
  readonly authorId: string | undefined;
  readonly text: string | undefined;
  readonly trust?: WakeTrust;
  readonly now?: Date;
}): Promise<string | undefined> {
  const code = detectLinkClaim(input.text);
  if (!code) return undefined;
  if (input.text && isEnvelopeShaped(input.text)) {
    log("link claim seen in envelope-shaped text (multiple authors) — ignored (a claim's code and its claimant must come from ONE message).");
    return undefined;
  }
  if (!input.authorId) {
    log("link claim seen with no captured author id — ignored (a claim is only ever as good as the author the surface resolved).");
    return undefined;
  }
  if (input.trust !== "peer" && input.trust !== "principal") {
    log(`link claim from a non-vouched author (trust=${input.trust ?? "unknown"}) — ignored (only an identified internal human may claim).`);
    return undefined;
  }
  const claimed = await claimLinkChallenge({
    org: input.org,
    code,
    claimant: { platform: input.platform, nativeId: input.authorId },
    ...(input.now ? { now: input.now } : {}),
  });
  if (!claimed) return undefined;

  const claimant = principalKey(input.platform, input.authorId);
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
      if (!detectLinkClaim(raw)) return;
      try {
        const binding = bindFrom(ctx as BindableContext);
        const authorId = actingPrincipalId(binding);
        const trust: WakeTrust = authorId === undefined ? "relay" : binding.trust === "internal" ? "peer" : "unauth";
        await observeLinkClaim({
          org: binding.org,
          platform: binding.platform,
          authorId,
          text: raw,
          trust,
        });
      } catch (err) {
        log(`link claim check skipped: ${String(err)}`);
      }
    },
  },
});
