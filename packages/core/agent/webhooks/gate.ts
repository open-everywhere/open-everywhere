import { createHmac, timingSafeEqual } from "node:crypto";
import type { WebhookHook } from "./config.js";

const DEFAULT_MAX_BODY_BYTES = 256 * 1024;

export function webhookMaxBodyBytes(): number {
  const raw = process.env.OE_WEBHOOK_MAX_BODY_BYTES;
  if (raw === undefined) return DEFAULT_MAX_BODY_BYTES;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_BODY_BYTES;
}

export function verifyWebhookSignature(secret: string, body: string, signatureHeader: string | null | undefined): boolean {
  if (!signatureHeader) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex");
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface WebhookRejection {
  readonly status: number;
  readonly reason: string;
}

export function gateWebhookDelivery(args: {
  readonly hook: WebhookHook | undefined;
  readonly secretValue: string | undefined;
  readonly body: string;
  readonly bodyBytes: number;
  readonly signatureHeader: string | null;
  readonly allowUnverified: boolean;
  readonly maxBodyBytes: number;
}): WebhookRejection | null {
  const { hook, secretValue, body, bodyBytes, signatureHeader, allowUnverified, maxBodyBytes } = args;
  if (!hook) return { status: 404, reason: "unknown webhook id" };
  if (bodyBytes > maxBodyBytes) return { status: 413, reason: `payload exceeds ${maxBodyBytes} bytes` };
  if (!secretValue) {
    return allowUnverified
      ? null
      : {
          status: 401,
          reason: `${hook.secretEnv} is not set — rejecting unverified delivery (set the secret, or OE_ALLOW_UNVERIFIED_WEBHOOK=1 for local dev)`,
        };
  }
  return verifyWebhookSignature(secretValue, body, signatureHeader) ? null : { status: 401, reason: "invalid signature" };
}
