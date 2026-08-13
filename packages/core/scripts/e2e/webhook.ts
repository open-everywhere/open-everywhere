import { createHmac, randomUUID } from "node:crypto";
import type { WebhookConfig } from "./env.js";

export const WEBHOOK_ID_HEADER = "webhook-id";
export const WEBHOOK_TIMESTAMP_HEADER = "webhook-timestamp";
export const WEBHOOK_SIGNATURE_HEADER = "webhook-signature";

function keyBytes(secret: string): Buffer {
  return secret.startsWith("whsec_") ? Buffer.from(secret.slice("whsec_".length), "base64") : Buffer.from(secret, "utf8");
}

export function signWebhookBody(secret: string, rawBody: string, timestamp: string, messageId: string): string {
  return "v1," + createHmac("sha256", keyBytes(secret)).update(`${messageId}.${timestamp}.${rawBody}`, "utf8").digest("base64");
}

export function webhookTimestamp(nowMs: number = Date.now()): string {
  return String(Math.floor(nowMs / 1000));
}

export function webhookDeliveryId(): string {
  return `e2e-${randomUUID()}`;
}

export interface WebhookPostResult {
  readonly status: number;
  readonly body: string;
}

export type WebhookFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  readonly status: number;
  text(): Promise<string>;
}>;

export class WebhookDriver {
  constructor(
    private readonly cfg: WebhookConfig,
    private readonly fetchImpl: WebhookFetch = (url, init) => fetch(url, init),
  ) {}

  get hookId(): string {
    return this.cfg.hookId;
  }

  async post(payload: unknown, opts: { signed?: boolean; staleSeconds?: number; deliveryId?: string } = {}): Promise<WebhookPostResult> {
    const rawBody = JSON.stringify(payload);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.signed !== false) {
      const timestamp = webhookTimestamp(Date.now() - (opts.staleSeconds ?? 0) * 1000);
      const messageId = opts.deliveryId ?? webhookDeliveryId();
      headers[WEBHOOK_ID_HEADER] = messageId;
      headers[WEBHOOK_TIMESTAMP_HEADER] = timestamp;
      headers[WEBHOOK_SIGNATURE_HEADER] = signWebhookBody(this.cfg.secret, rawBody, timestamp, messageId);
    } else if (opts.deliveryId) {
      headers[WEBHOOK_ID_HEADER] = opts.deliveryId;
    }
    const res = await this.fetchImpl(`${this.cfg.targetUrl}/webhooks/${this.cfg.hookId}`, {
      method: "POST",
      headers,
      body: rawBody,
    });
    return { status: res.status, body: await res.text() };
  }
}
