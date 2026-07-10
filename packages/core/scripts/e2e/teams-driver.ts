import type { TeamsDriverConfig } from "./env.js";
import { pollUntil, sleep } from "./poll.js";

const TOKEN_BASE = "https://login.microsoftonline.com";
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const TOKEN_SKEW_MS = 60_000;

export interface TeamsMessage {
  readonly id: string;
  readonly fromApplicationId?: string;
  readonly fromUserId?: string;
  readonly text: string;
  readonly createdDateTime?: string;
}

interface GraphChatMessage {
  id?: string;
  from?: { application?: { id?: string }; user?: { id?: string } };
  body?: { contentType?: string; content?: string };
  createdDateTime?: string;
}

function htmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function toMessage(m: GraphChatMessage): TeamsMessage {
  return {
    id: m.id ?? "",
    fromApplicationId: m.from?.application?.id,
    fromUserId: m.from?.user?.id,
    text: stripHtml(m.body?.content ?? ""),
    createdDateTime: m.createdDateTime,
  };
}

export class TeamsDriver {
  constructor(private readonly cfg: TeamsDriverConfig) {}

  private cached?: { token: string; expiresAt: number };

  private async accessToken(): Promise<string> {
    if (this.cached && Date.now() < this.cached.expiresAt - TOKEN_SKEW_MS) return this.cached.token;
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: this.cfg.clientId,
      refresh_token: this.cfg.refreshToken,
      scope: "https://graph.microsoft.com/.default",
    });
    const res = await fetch(`${TOKEN_BASE}/${this.cfg.tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const json = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      refresh_token?: string;
      error?: string;
      error_description?: string;
    };
    if (!res.ok || !json.access_token) {
      const detail = json.error_description ?? json.error ?? `http ${res.status}`;
      throw new Error(`teams token exchange failed: ${detail}`);
    }
    if (json.refresh_token && json.refresh_token !== this.cfg.refreshToken) {
      console.warn(
        "[e2e:teams] Azure returned a rotated refresh_token — this run keeps the configured one; re-run `npm run e2e:teams-auth` if auth later starts failing.",
      );
    }
    const expiresAt = Date.now() + (json.expires_in ?? 3600) * 1_000;
    this.cached = { token: json.access_token, expiresAt };
    return json.access_token;
  }

  private async graph(method: "GET" | "POST", path: string, body?: unknown, retried = false): Promise<unknown> {
    const token = await this.accessToken();
    const res = await fetch(`${GRAPH_BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 && !retried) {
      const retryAfter = Number(res.headers.get("retry-after") ?? "1");
      await sleep(Math.min((Number.isFinite(retryAfter) ? retryAfter : 1) * 1_000, 10_000));
      return this.graph(method, path, body, true);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`teams ${method} ${path} failed: http ${res.status} ${text}`);
    }
    return res.json();
  }

  async postMention(text: string): Promise<TeamsMessage> {
    const json = (await this.graph("POST", `/teams/${this.cfg.teamId}/channels/${this.cfg.channelId}/messages`, {
      body: { contentType: "html", content: `<at id="0">Open Everywhere</at> ${htmlEscape(text)}` },
      mentions: [
        {
          id: 0,
          mentionText: "Open Everywhere",
          mentioned: {
            application: { id: this.cfg.botAppId, displayName: "Open Everywhere", applicationIdentityType: "bot" },
          },
        },
      ],
    })) as GraphChatMessage;
    return toMessage(json);
  }

  async postReply(rootMessageId: string, text: string): Promise<TeamsMessage> {
    const json = (await this.graph("POST", `/teams/${this.cfg.teamId}/channels/${this.cfg.channelId}/messages/${rootMessageId}/replies`, {
      body: { contentType: "html", content: htmlEscape(text) },
    })) as GraphChatMessage;
    return toMessage(json);
  }

  async postMentionReply(rootMessageId: string, text: string): Promise<TeamsMessage> {
    const json = (await this.graph("POST", `/teams/${this.cfg.teamId}/channels/${this.cfg.channelId}/messages/${rootMessageId}/replies`, {
      body: { contentType: "html", content: `<at id="0">Open Everywhere</at> ${htmlEscape(text)}` },
      mentions: [{ id: 0, mentionText: "Open Everywhere", mentioned: { application: { id: this.cfg.botAppId, displayName: "Open Everywhere", applicationIdentityType: "bot" } } }],
    })) as GraphChatMessage;
    return toMessage(json);
  }

  async replies(rootMessageId: string): Promise<readonly TeamsMessage[]> {
    const json = (await this.graph(
      "GET",
      `/teams/${this.cfg.teamId}/channels/${this.cfg.channelId}/messages/${rootMessageId}/replies`,
    )) as { value?: readonly GraphChatMessage[] };
    return (json.value ?? []).map(toMessage);
  }

  isBotReply(m: TeamsMessage): boolean {
    return m.fromApplicationId === this.cfg.botAppId && m.text.trim().length > 0;
  }

  async awaitReply(rootMessageId: string, opts: { timeoutMs: number; afterIso?: string }): Promise<TeamsMessage> {
    return pollUntil(
      async () => (await this.replies(rootMessageId)).find((m) => this.isBotReply(m) && (opts.afterIso === undefined || (m.createdDateTime ?? "") > opts.afterIso!)),
      { timeoutMs: opts.timeoutMs, what: `a bot reply in the reply chain of message ${rootMessageId}${opts.afterIso ? ` after ${opts.afterIso}` : ""}` },
    );
  }

  async collectBotRepliesDuring(rootMessageId: string, afterIso: string, windowMs: number): Promise<readonly TeamsMessage[]> {
    await sleep(windowMs);
    return (await this.replies(rootMessageId)).filter((m) => this.isBotReply(m) && (m.createdDateTime ?? "") > afterIso);
  }
}
