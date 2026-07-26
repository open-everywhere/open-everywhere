import { createHmac } from "node:crypto";
import type { WebhookConfig } from "./env.js";

export const WEBHOOK_TIMESTAMP_HEADER = "x-hook-timestamp";

export function signWebhookBody(secret: string, rawBody: string, timestamp: string): string {
  return "sha256=" + createHmac("sha256", secret).update(`v1:${timestamp}:${rawBody}`, "utf8").digest("hex");
}

export function webhookTimestamp(nowMs: number = Date.now()): string {
  return String(Math.floor(nowMs / 1000));
}

export interface WebhookPostResult {
  readonly status: number;
  readonly body: string;
}

export class WebhookDriver {
  constructor(private readonly cfg: WebhookConfig) {}

  get hookId(): string {
    return this.cfg.hookId;
  }

  async post(payload: unknown, opts: { signed?: boolean; staleSeconds?: number } = {}): Promise<WebhookPostResult> {
    const rawBody = JSON.stringify(payload);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.signed !== false) {
      const timestamp = webhookTimestamp(Date.now() - (opts.staleSeconds ?? 0) * 1000);
      headers[WEBHOOK_TIMESTAMP_HEADER] = timestamp;
      headers["x-hook-signature-256"] = signWebhookBody(this.cfg.secret, rawBody, timestamp);
    }
    const res = await fetch(`${this.cfg.targetUrl}/webhooks/${this.cfg.hookId}`, {
      method: "POST",
      headers,
      body: rawBody,
    });
    return { status: res.status, body: await res.text() };
  }
}
