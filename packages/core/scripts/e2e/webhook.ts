import { createHmac } from "node:crypto";
import type { WebhookConfig } from "./env.js";

export function signWebhookBody(secret: string, rawBody: string): string {
  return "sha256=" + createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
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

  async post(payload: unknown, opts: { signed?: boolean } = {}): Promise<WebhookPostResult> {
    const rawBody = JSON.stringify(payload);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.signed !== false) {
      headers["x-hook-signature-256"] = signWebhookBody(this.cfg.secret, rawBody);
    }
    const res = await fetch(`${this.cfg.targetUrl}/webhooks/${this.cfg.hookId}`, {
      method: "POST",
      headers,
      body: rawBody,
    });
    return { status: res.status, body: await res.text() };
  }
}
