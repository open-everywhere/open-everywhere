import { randomBytes } from "node:crypto";
import { appendAudit } from "../audit/audit.js";
import { getConfig } from "../access/config.js";
import { emitTelemetry } from "../observability/telemetry.js";
import { encryptedKvVault } from "../credentials/kv-vault.js";
import { getOperationalStore } from "../operational/provider.js";
import { bridgeSlackForm } from "../channels/slack-bridge.js";
import { issueRevealLink } from "../webhooks/reveal-page.js";
import {
  describeRuntimeHook,
  mintRuntimeHookId,
  rotationOverlapMs,
  runtimeHookPrevSecretRef,
  runtimeHookSecretRef,
  type RuntimeWebhookHook,
  type WebhookPosture,
} from "../webhooks/runtime-hook.js";
import { registerActionKind } from "./actions.js";
import type { ActionKind } from "./types.js";

const SECRET_BYTES = 32;

function mintSecret(): string {
  return randomBytes(SECRET_BYTES).toString("base64url");
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
  summarize(args) {
    return [
      `Create an inbound webhook — ${describeRuntimeHook({ source: args.source, ...(args.scheme ? { scheme: args.scheme } : {}), posture: args.posture, status: "active" })}`,
      ...(args.posture === "content-bearing"
        ? [
            "⚠ CONTENT-BEARING: whatever this sender posts becomes part of the prompt, on every delivery, indefinitely — treat it like an untrusted person typing into the channel. Anything the agent then tries to do off that content is treated as tainted and re-asks you.",
          ]
        : ["🔒 TRIGGER-ONLY: the payload is discarded. Deliveries can only cause a routine you already approved to run — nothing the sender writes reaches the agent."]),
      "A signing secret is generated when you approve. You get a ONE-TIME link to read it — it is never shown in chat and cannot be shown again; a lost secret means rotating.",
      `Requested by ${args.requestedBy}`,
    ];
  },
  async execute(args, decidedBy) {
    const now = new Date();
    const id = mintRuntimeHookId();
    const secretRef = runtimeHookSecretRef(id);
    const store = getOperationalStore();

    const ownerDomain = getConfig().domainsForSurface({
      workspaceKey: args.surfaceKey.split("/").slice(0, 2).join("/"),
      surface: args.surfaceKey.split("/")[2] ?? "",
    })[0];

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
      ...(ownerDomain ? { ownerDomain } : {}),
      createdAt: now.toISOString(),
    };

    if (!(await store.addWebhookHook(hook))) {
      emitTelemetry("oe.feature.used", { "oe.feature": "webhook_created", "oe.outcome": "declined" });
      return (
        `no webhook created — a "${args.source}" webhook already exists here (one per name per org). ` +
        `Nothing was minted and nothing changed. Check list_webhooks: if it's live, point the sender at that one, or rotate its secret.`
      );
    }

    const secret = mintSecret();
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
        ...(ownerDomain ? { ownerDomain } : {}),
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
  readonly posture: WebhookPosture;
  readonly surfaceKey: string;
  readonly requestedBy: string;
  readonly platform: string;
  readonly channelId: string;
}

const webhookRotate: ActionKind<WebhookRotateArgs> = {
  kind: "webhook.rotate",
  policy: "member",
  summarize(args) {
    const hours = Math.round(rotationOverlapMs() / 3_600_000);
    return [
      `Rotate the signing secret for the "${args.source}" webhook`,
      `The current secret keeps working for ${hours}h so the sender doesn't break while you update it, then stops.`,
      "You get a ONE-TIME link to read the new secret. The OLD one is not recoverable and is never shown again.",
      `Requested by ${args.requestedBy}`,
    ];
  },
  async execute(args, decidedBy) {
    const store = getOperationalStore();
    const existing = await store.getWebhookHookById(args.id);
    if (!existing || existing.org !== args.org) {
      return `no webhook "${args.source}" on this deployment any more — nothing to rotate.`;
    }
    if (existing.status !== "active") {
      return `webhook "${args.source}" is ${existing.status}, not live — nothing to rotate. Nothing was minted and nothing changed.`;
    }
    const vault = encryptedKvVault();
    const now = new Date();
    const prevRef = runtimeHookPrevSecretRef(args.id);
    const outgoing = await vault.read(existing.secretRef);
    if (outgoing) await vault.write(prevRef, outgoing, { provider: "webhook", domain: `${args.source} (superseded)`, createdBy: decidedBy });

    const secret = mintSecret();
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

export interface WebhookRevokeArgs {
  readonly org: string;
  readonly id: string;
  readonly source: string;
  readonly surfaceKey: string;
  readonly requestedBy: string;
}

const webhookRevoke: ActionKind<WebhookRevokeArgs> = {
  kind: "webhook.revoke",
  policy: "member",
  summarize(args) {
    return [
      `Revoke the "${args.source}" webhook — the endpoint stops accepting anything, immediately`,
      `Whatever is sending to it will start failing. NOT reversible: the row is kept so the endpoint stays dead, and that retires the "${args.source}" name — no replacement webhook can be created for it afterwards. If the secret leaked but you want the integration, cancel this and rotate instead.`,
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
    for (const ref of [updated.secretRef, updated.prevSecretRef]) {
      if (!ref) continue;
      try {
        await vault.write(ref, mintSecret(), { provider: "webhook", domain: `${args.source} (revoked)`, createdBy: decidedBy });
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
      detail: { hookId: args.id, source: args.source, revokedBy: decidedBy, requestedBy: args.requestedBy },
    });
    emitTelemetry("oe.feature.used", { "oe.feature": "webhook_revoked", "oe.outcome": "ok" });
    return `webhook "${args.source}" revoked — its endpoint now behaves exactly as if it had never existed.`;
  },
};

registerActionKind(webhookCreate);
registerActionKind(webhookRotate);
registerActionKind(webhookRevoke);
