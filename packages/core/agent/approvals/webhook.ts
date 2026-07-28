import { randomBytes } from "node:crypto";
import { appendAudit } from "../audit/audit.js";
import { getConfig } from "../access/config.js";
import { configHookPosture, findWebhook, hookSecretRefs, hooksSharingSecretRef } from "../webhooks/config.js";
import { describeReadableBy, readableByDefects, type ReadableBy } from "../access/read-grant.js";
import { emitTelemetry } from "../observability/telemetry.js";
import { encryptedKvVault } from "../credentials/kv-vault.js";
import { getOperationalStore } from "../operational/provider.js";
import { bridgeSlackForm } from "../channels/slack-bridge.js";
import { issueRevealLink } from "../webhooks/reveal-page.js";
import {
  describeRuntimeHook,
  mintRuntimeHookId,
  ownsSecretRef,
  rotationOverlapMs,
  runtimeHookPrevSecretRef,
  runtimeHookSecretRef,
  type RuntimeWebhookHook,
  type WebhookPosture,
} from "../webhooks/runtime-hook.js";
import { webhookScheme } from "../routines/scheme-name.js";
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

export interface WebhookCreateArgs {
  readonly org: string;
  readonly source: string;
  readonly scheme?: string;
  readonly posture: WebhookPosture;
  readonly surfaceKey: string;
  readonly requestedBy: string;
  readonly platform: string;
  readonly channelId: string;
}

const webhookCreate: ActionKind<WebhookCreateArgs> = {
  kind: "webhook.create",
  policy: "member",
  beneficiaryClicker: true,
  summarize(args) {
    return [
      `Create an inbound webhook — ${describeRuntimeHook({ source: args.source, ...(args.scheme ? { scheme: args.scheme } : {}), posture: args.posture, status: "active" })}`,
      ...(args.posture === "content-bearing"
        ? [
            "⚠ CONTENT-BEARING: whatever this sender posts becomes part of the prompt, on every delivery, indefinitely — treat it like an untrusted person typing into the channel. Anything the agent then tries to do off that content is treated as tainted and re-asks you.",
          ]
        : ["🔒 TRIGGER-ONLY: the payload is discarded. Deliveries can only cause a routine you already approved to run — nothing the sender writes reaches the agent."]),
      "Its events will be readable by the memory domain(s) this channel belongs to, and by nothing else. If it belongs to none, approving is refused rather than creating a hook nothing can ever act on.",
      "A signing secret is generated when you approve. You get a ONE-TIME link to read it — it is never shown in chat and cannot be shown again; a lost secret means rotating.",
      `Requested by ${args.requestedBy}`,
    ];
  },
  async execute(args, decidedBy) {
    const now = new Date();
    const id = mintRuntimeHookId();
    const secretRef = runtimeHookSecretRef(id);
    const store = getOperationalStore();

    const domains = getConfig().domainsForSurface({
      workspaceKey: args.surfaceKey.split("/").slice(0, 2).join("/"),
      surface: args.surfaceKey.split("/")[2] ?? "",
    });
    const readableBy: ReadableBy = domains.map((domain) => ({ level: "domain", domain }));
    if (readableByDefects(readableBy).length > 0) {
      emitTelemetry("oe.feature.used", { "oe.feature": "webhook_created", "oe.outcome": "declined" });
      return (
        `no webhook created — this channel doesn't belong to any memory domain, so there is nobody the hook's events could be read by. ` +
        `A webhook with an empty read grant accepts deliveries and then refuses every routine, forever, silently; I won't create one. ` +
        `An operator needs to add this channel to a domain in the app's \`memory/domains.ts\` (merged by PR), then ask again. Nothing was minted.`
      );
    }

    const hook: RuntimeWebhookHook = {
      org: args.org,
      id,
      source: args.source,
      ...(args.scheme && args.scheme !== args.source ? { scheme: args.scheme } : {}),
      posture: args.posture,
      secretRef,
      status: "active",
      createdBy: decidedBy,
      createdIn: args.surfaceKey,
      readableBy,
      createdAt: now.toISOString(),
    };

    if (!(await store.addWebhookHook(hook))) {
      emitTelemetry("oe.feature.used", { "oe.feature": "webhook_created", "oe.outcome": "declined" });
      return (
        `no webhook created — a "${args.source}" webhook already exists here (one per name per org). ` +
        `Nothing was minted and nothing changed. Check list_webhooks: if it's live, point the sender at that one, or rotate its secret.`
      );
    }

    const secret = mintSecretFor(webhookScheme(hook));
    try {
      await encryptedKvVault().write(secretRef, secret, { provider: "webhook", domain: args.source, createdBy: decidedBy });
    } catch {
      await store.updateWebhookHook(args.org, id, { status: "revoked", revokedBy: decidedBy, revokedAt: new Date().toISOString() });
      emitTelemetry("oe.feature.used", { "oe.feature": "webhook_created", "oe.outcome": "failed" });
      return `couldn't create the "${args.source}" webhook — its signing secret could not be stored, so I've disabled the half-built hook rather than leave an endpoint nothing can authenticate. Nothing is live and no secret was issued.`;
    }

    const delivered = await deliverReveal({ org: args.org, ref: secretRef, source: args.source, to: decidedBy, platform: args.platform, channelId: args.channelId }, "created");

    await appendAudit({
      org: args.org,
      platform: args.surfaceKey.split("/")[0] ?? "webhook",
      workspace: args.surfaceKey.split("/")[1] ?? "-",
      surface: args.surfaceKey.split("/")[2] ?? "-",
      principalId: decidedBy,
      action: "webhook.created",
      detail: {
        hookId: id,
        source: args.source,
        ...(hook.scheme ? { scheme: hook.scheme } : {}),
        readableBy: describeReadableBy(readableBy),
        posture: args.posture,
        createdBy: decidedBy,
        requestedBy: args.requestedBy,
        revealDelivered: delivered,
      },
    });
    const createdOutcome = delivered ? "ok" : "failed";
    emitTelemetry("oe.feature.used", { "oe.feature": "webhook_created", "oe.outcome": createdOutcome });
    return delivered
      ? `webhook "${args.source}" created (${args.posture}) — I've sent you a private one-time link with its endpoint and signing secret. It works once.`
      : `webhook "${args.source}" created (${args.posture}), but I couldn't hand you the one-time secret link. The webhook exists and is safe — nobody has its secret — but it can't be used until you run rotate_webhook to issue a fresh one.`;
  },
};

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

function summarizeConfigRotate(args: WebhookRotateArgs): string[] {
  return [
    `Issue a new signing secret for the declared "${args.source}" webhook`,
    "If it has never had one, this is what makes it start authenticating — no redeploy, and no secret in the config diff.",
    "If it already has one, that value stops being accepted the moment this runs, UNLESS its declaration lists a second `secretRef` — that list IS the overlap, and it ends when a PR removes the entry, not on a timer.",
    "You get a ONE-TIME link to read the new secret. The old one is not recoverable and is never shown again.",
    `Requested by ${args.requestedBy}`,
  ];
}

async function executeConfigRotate(args: WebhookRotateArgs, decidedBy: string): Promise<string> {
  const hooks = getConfig().loadWebhooks?.() ?? [];
  const hook = findWebhook(hooks, args.configId!);
  if (!hook) {
    return `no webhook "${args.source}" is declared on this deployment any more — nothing to rotate. A declared hook only disappears when a PR removes it, so someone merged that while this card was waiting.`;
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
      hookClass: "config",
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
}

const webhookRotate: ActionKind<WebhookRotateArgs> = {
  kind: "webhook.rotate",
  policy: "member",
  beneficiaryClicker: true,
  summarize(args) {
    if (args.configId) return summarizeConfigRotate(args);
    const hours = Math.round(rotationOverlapMs() / 3_600_000);
    return [
      `Rotate the signing secret for the "${args.source}" webhook`,
      `The current secret keeps working for ${hours}h so the sender doesn't break while you update it, then stops.`,
      "You get a ONE-TIME link to read the new secret. The OLD one is not recoverable and is never shown again.",
      `Requested by ${args.requestedBy}`,
    ];
  },
  async execute(args, decidedBy) {
    if (args.configId) return executeConfigRotate(args, decidedBy);
    const store = getOperationalStore();
    const existing = await store.getWebhookHookById(args.id);
    if (!existing || existing.org !== args.org) {
      return `no webhook "${args.source}" on this deployment any more — nothing to rotate.`;
    }
    if (existing.status !== "active") {
      return `webhook "${args.source}" is ${existing.status}, not live — nothing to rotate. Nothing was minted and nothing changed.`;
    }

    if (!ownsSecretRef(args.id, existing.secretRef)) {
      emitTelemetry("oe.feature.used", { "oe.feature": "webhook_rotated", "oe.outcome": "declined" });
      return (
        `I can't rotate the "${args.source}" webhook: its signing secret is stored under a ref this hook does not own, which means something else is authenticating with the same key. ` +
        `Rotating would silently break whatever that is. Nothing was minted and nothing changed — an admin needs to look at this hook's storage by hand.`
      );
    }

    const vault = encryptedKvVault();
    const now = new Date();
    const prevRef = runtimeHookPrevSecretRef(args.id);
    const outgoing = await vault.read(existing.secretRef);
    if (outgoing) await vault.write(prevRef, outgoing, { provider: "webhook", domain: `${args.source} (superseded)`, createdBy: decidedBy });

    const secret = mintSecretFor(webhookScheme(existing));
    await vault.write(existing.secretRef, secret, { provider: "webhook", domain: args.source, createdBy: decidedBy });

    const overlapUntil = new Date(now.getTime() + rotationOverlapMs()).toISOString();
    await store.updateWebhookHook(args.org, args.id, {
      ...(outgoing ? { prevSecretRef: prevRef, prevExpiresAt: overlapUntil } : {}),
    });

    const delivered = await deliverReveal(
      { org: args.org, ref: existing.secretRef, source: args.source, to: decidedBy, platform: args.platform, channelId: args.channelId },
      "rotated",
    );

    await appendAudit({
      org: args.org,
      platform: args.surfaceKey.split("/")[0] ?? "webhook",
      workspace: args.surfaceKey.split("/")[1] ?? "-",
      surface: args.surfaceKey.split("/")[2] ?? "-",
      principalId: decidedBy,
      action: "webhook.rotated",
      detail: { hookId: args.id, source: args.source, rotatedBy: decidedBy, requestedBy: args.requestedBy, ...(outgoing ? { overlapUntil } : {}), revealDelivered: delivered },
    });
    const rotatedOutcome = delivered ? "ok" : "failed";
    emitTelemetry("oe.feature.used", { "oe.feature": "webhook_rotated", "oe.outcome": rotatedOutcome });
    return delivered
      ? `webhook "${args.source}" rotated — I've sent you a private one-time link with the new secret.${outgoing ? ` The old one keeps working until ${overlapUntil}.` : ""}`
      : `webhook "${args.source}" rotated, but I couldn't hand you the one-time secret link — so the new secret is unreachable and the old one stops working${outgoing ? ` at ${overlapUntil}` : " now"}. Rotate again once private delivery works here.`;
  },
};

const REVOKE_REMEDIATION_NOTE =
  "Its signing secret was minted here, so revoking is the whole story — nothing outside this deployment is left holding a key that still works.";

export interface WebhookRevokeArgs {
  readonly org: string;
  readonly id: string;
  readonly source: string;
  readonly scheme?: string;
  readonly surfaceKey: string;
  readonly requestedBy: string;
}

const webhookRevoke: ActionKind<WebhookRevokeArgs> = {
  kind: "webhook.revoke",
  policy: "member",
  summarize(args) {
    return [
      `Revoke the "${args.source}" webhook — the endpoint stops accepting anything, immediately`,
      `Whatever is sending to it will start failing. NOT reversible: the row is kept so the endpoint stays dead, and that retires the "${args.source}" name — no replacement webhook can be created for it afterwards.` +
        " If the secret leaked but you want the integration, cancel this and rotate instead.",
      REVOKE_REMEDIATION_NOTE,
      `Requested by ${args.requestedBy}`,
    ];
  },
  async execute(args, decidedBy) {
    const store = getOperationalStore();
    const now = new Date();
    const updated = await store.updateWebhookHook(args.org, args.id, {
      status: "revoked",
      revokedBy: decidedBy,
      revokedAt: now.toISOString(),
    });
    if (!updated) return `no webhook "${args.source}" on this deployment — nothing to revoke (it may already be gone).`;

    const vault = encryptedKvVault();
    let scrubbed = 0;
    let skipped = 0;
    for (const ref of [updated.secretRef, updated.prevSecretRef]) {
      if (!ref) continue;
      if (!ownsSecretRef(args.id, ref)) {
        skipped++;
        console.log(
          `[open-everywhere:webhooks] "${args.source}" revoked, but its stored key was left in place: the ref is not this hook's own, so something else may be authenticating with it. Scrub it by hand once you know what else points there.`,
        );
        continue;
      }
      try {
        await vault.write(ref, mintSecret(), { provider: "webhook", domain: `${args.source} (revoked)`, createdBy: decidedBy });
        scrubbed++;
      } catch {
      }
    }

    await appendAudit({
      org: args.org,
      platform: args.surfaceKey.split("/")[0] ?? "webhook",
      workspace: args.surfaceKey.split("/")[1] ?? "-",
      surface: args.surfaceKey.split("/")[2] ?? "-",
      principalId: decidedBy,
      action: "webhook.revoked",
      detail: {
        hookId: args.id,
        source: args.source,
        keysScrubbed: scrubbed,
        ...(skipped ? { keysLeftInPlace: skipped } : {}),
        revokedBy: decidedBy,
        requestedBy: args.requestedBy,
      },
    });
    emitTelemetry("oe.feature.used", { "oe.feature": "webhook_revoked", "oe.outcome": "ok" });
    return `webhook "${args.source}" revoked — its endpoint now behaves exactly as if it had never existed. ${REVOKE_REMEDIATION_NOTE}`;
  },
};

registerActionKind(webhookCreate);
registerActionKind(webhookRotate);
registerActionKind(webhookRevoke);
