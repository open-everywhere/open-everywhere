import { randomBytes } from "node:crypto";
import { appendAudit } from "../audit/audit.js";
import { getConfig } from "../access/config.js";
import { configHookPosture, findWebhook, hookSecretRefs, hooksSharingSecretRef, type WebhookPosture } from "../webhooks/config.js";
import { emitTelemetry } from "../observability/telemetry.js";
import { encryptedKvVault } from "../credentials/kv-vault.js";
import { bridgeSlackForm } from "../channels/slack-bridge.js";
import { issueRevealLink } from "../webhooks/reveal-page.js";
import { webhookVerifier } from "../webhooks/verifier.js";
import { registerActionKind } from "./actions.js";
import type { ActionKind } from "./types.js";

const SECRET_BYTES = 32;

function mintSecret(): string {
  return randomBytes(SECRET_BYTES).toString("base64url");
}

function mintSecretFor(scheme: string): string {
  return webhookVerifier(scheme)?.mintSecret?.() ?? mintSecret();
}

export interface RevealDeliveryDeps {
  readonly postPrivate?: (channelId: string, userId: string, text: string) => Promise<boolean>;
  readonly issueLink?: typeof issueRevealLink;
}

let deliveryDeps: RevealDeliveryDeps = {};

export function setRevealDeliveryDepsForTest(deps: RevealDeliveryDeps): () => void {
  const prev = deliveryDeps;
  deliveryDeps = deps;
  return () => {
    deliveryDeps = prev;
  };
}

async function livePostPrivate(channelId: string, userId: string, text: string): Promise<boolean> {
  const body = new URLSearchParams();
  body.set("channel", channelId);
  body.set("user", userId);
  body.set("text", text);
  body.set("unfurl_links", "false");
  body.set("unfurl_media", "false");
  const res = await bridgeSlackForm("chat.postEphemeral", body.toString());
  return res?.ok === true;
}

async function deliverReveal(
  args: { readonly org: string; readonly ref: string; readonly source: string; readonly to: string; readonly platform: string; readonly channelId: string },
  what: "created" | "rotated",
): Promise<boolean> {
  if (args.platform !== "slack") return false;
  const issue = deliveryDeps.issueLink ?? issueRevealLink;
  const link = await issue({ org: args.org, ref: args.ref, revealTo: args.to, label: args.source });
  if (!link) return false;
  const post = deliveryDeps.postPrivate ?? livePostPrivate;
  return post(
    args.channelId,
    args.to,
    `Your "${args.source}" webhook was ${what}. Open this link to see its endpoint URL and signing secret — ` +
      `it works ONCE, expires in 15 minutes, and only you can see this message:\n${link.url}\n\n` +
      `Nothing can show you the secret again. If you lose it, ask me to rotate the webhook.`,
  );
}

export interface WebhookRotateArgs {
  readonly org: string;
  readonly id: string;
  readonly source: string;
  readonly configId?: string;
  readonly posture: WebhookPosture;
  readonly scheme?: string;
  readonly surfaceKey: string;
  readonly requestedBy: string;
  readonly platform: string;
  readonly channelId: string;
}

export interface WebhookRotateArgs {
  readonly org: string;
  readonly hookId: string;
  readonly posture: WebhookPosture;
  readonly surfaceKey: string;
  readonly requestedBy: string;
  readonly platform: string;
  readonly channelId: string;
}

const webhookRotate: ActionKind<WebhookRotateArgs> = {
  kind: "webhook.rotate",
  policy: "member",
  beneficiaryClicker: true,
  summarize(args) {
    return [
      `Issue a new signing secret for the declared "${args.hookId}" webhook`,
      "If it has never had one, this is what makes it start authenticating — no redeploy, and no secret in the config diff.",
      "If it already has one, that value stops being accepted the moment this runs, UNLESS its declaration lists a second `secretRef` — that list IS the overlap, and it ends when a PR removes the entry, not on a timer.",
      "You get a ONE-TIME link to read the new secret. The old one is not recoverable and is never shown again.",
      `Requested by ${args.requestedBy}`,
    ];
  },
  async execute(args, decidedBy) {
    const hooks = getConfig().loadWebhooks?.() ?? [];
    const hook = findWebhook(hooks, args.hookId);
    if (!hook) {
      return `no webhook "${args.hookId}" is declared on this deployment any more — nothing to rotate. A declared hook only disappears when a PR removes it, so someone merged that while this card was waiting.`;
    }
    if (hook.broker !== "db") {
      return (
        `I can't issue a secret for "${hook.id}" — its declaration says the value lives under the "${hook.broker}" broker, which is set outside this deployment. ` +
        `An operator sets it there (for \`env\`, the variable \`${hookSecretRefs(hook)[0]}\`) and redeploys. Nothing was minted and nothing changed. ` +
        `To make this rotatable from here instead, the declaration has to be changed to \`broker: "db"\` by PR.`
      );
    }
    const refs = hookSecretRefs(hook);
    const currentRef = refs[0]!;
    const shared = hooksSharingSecretRef(hooks, hook.id, currentRef);
    if (shared.length > 0) {
      emitTelemetry("oe.feature.used", { "oe.feature": "webhook_rotated", "oe.outcome": "declined" });
      return (
        `I can't rotate "${hook.id}": its signing secret is stored under a ref that ${shared.length > 1 ? "webhooks" : "the webhook"} ${shared.map((h) => `"${h}"`).join(", ")} also ${shared.length > 1 ? "declare" : "declares"}, ` +
        `so re-minting it would silently break ${shared.length > 1 ? "them" : "it"} too. Nothing was minted and nothing changed — give each hook its own ref, by PR, first.`
      );
    }

    const vault = encryptedKvVault();
    const outgoing = await vault.read(currentRef);
    const overlapRef = refs[1];
    let overlapped = false;
    if (outgoing && overlapRef && hooksSharingSecretRef(hooks, hook.id, overlapRef).length === 0) {
      await vault.write(overlapRef, outgoing, { provider: "webhook", domain: `${hook.id} (superseded)`, createdBy: decidedBy });
      overlapped = true;
    }

    const secret = mintSecretFor(hook.source);
    await vault.write(currentRef, secret, { provider: "webhook", domain: hook.id, createdBy: decidedBy });

    const delivered = await deliverReveal(
      { org: args.org, ref: currentRef, source: hook.id, to: decidedBy, platform: args.platform, channelId: args.channelId },
      outgoing ? "rotated" : "created",
    );

    await appendAudit({
      org: args.org,
      platform: args.surfaceKey.split("/")[0] ?? "webhook",
      workspace: args.surfaceKey.split("/")[1] ?? "-",
      surface: args.surfaceKey.split("/")[2] ?? "-",
      principalId: decidedBy,
      action: "webhook.rotated",
      detail: {
        hookId: hook.id,
        source: hook.id,
        posture: configHookPosture(hook),
        first: !outgoing,
        overlapped,
        rotatedBy: decidedBy,
        requestedBy: args.requestedBy,
        revealDelivered: delivered,
      },
    });
    const outcome = delivered ? "ok" : "failed";
    emitTelemetry("oe.feature.used", { "oe.feature": "webhook_rotated", "oe.outcome": outcome });
    if (!delivered) {
      return (
        `webhook "${hook.id}" has a new signing secret, but I couldn't hand you the one-time link — so nobody has the new value and the endpoint won't authenticate anything until this is run again from a surface where I can message you privately.` +
        (overlapped ? " Its declared previous-key ref still holds the old value, so an existing sender keeps working meanwhile." : "")
      );
    }
    return outgoing
      ? `webhook "${hook.id}" rotated — I've sent you a private one-time link with the new secret.` +
          (overlapped
            ? " The old value moved to the second `secretRef` its declaration lists, so it keeps being accepted until a PR removes that entry."
            : " Its declaration lists one `secretRef`, so the old value stopped being accepted just now — update the sender before it retries.")
      : `webhook "${hook.id}" now has a signing secret — I've sent you a private one-time link with it. Paste it into the sender and the endpoint starts authenticating; nothing needed redeploying.`;
  },
};

registerActionKind(webhookRotate);
