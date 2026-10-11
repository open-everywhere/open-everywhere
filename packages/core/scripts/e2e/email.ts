import type { EmailFixtureConfig } from "./env.js";

export interface EmailFixtureMessage {
  readonly messageId: string;
  readonly threadId: string;
  readonly from: string;
  readonly subject: string;
  readonly text: string;
  readonly timestamp: string;
}

const REQUEST_TIMEOUT_MS = 20_000;

export class EmailFixtureDriver {
  constructor(readonly cfg: EmailFixtureConfig) {}

  private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.cfg.apiBase}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.cfg.apiKey}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`email fixture ${method} ${path.split("?")[0]} failed: HTTP ${res.status}`);
    return (await res.json().catch(() => ({}))) as Record<string, unknown>;
  }

  async send(fromInbox: string, to: readonly string[], subject: string, text: string): Promise<{ messageId: string; threadId: string }> {
    const out = await this.call("POST", `/v0/inboxes/${encodeURIComponent(fromInbox)}/messages/send`, { to: [...to], subject, text });
    return { messageId: String(out.message_id ?? ""), threadId: String(out.thread_id ?? "") };
  }

  async messagesFrom(inbox: string, from: string, afterIso: string): Promise<readonly EmailFixtureMessage[]> {
    const q = new URLSearchParams({ from, after: afterIso, limit: "50" });
    const out = await this.call("GET", `/v0/inboxes/${encodeURIComponent(inbox)}/messages?${q.toString()}`);
    const rows = Array.isArray(out.messages) ? (out.messages as Record<string, unknown>[]) : [];
    return rows.map((m) => ({
      messageId: String(m.message_id ?? ""),
      threadId: String(m.thread_id ?? ""),
      from: String(m.from ?? ""),
      subject: String(m.subject ?? ""),
      text: String(m.extracted_text ?? m.text ?? m.preview ?? ""),
      timestamp: String(m.timestamp ?? ""),
    }));
  }
}
