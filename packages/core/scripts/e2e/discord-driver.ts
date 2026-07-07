import type { DiscordDriverConfig } from "./env.js";
import { pollUntil, sleep } from "./poll.js";

const API_BASE = "https://discord.com/api/v10";

export interface DiscordMessage {
  readonly id: string;
  readonly channelId: string;
  readonly authorId: string;
  readonly authorIsBot: boolean;
  readonly content: string;
  readonly threadId?: string;
  readonly reactionEmoji: readonly string[];
  readonly components: readonly unknown[];
}

interface DiscordApiMessage {
  id?: string;
  channel_id?: string;
  author?: { id?: string; bot?: boolean };
  content?: string;
  thread?: { id?: string };
  reactions?: readonly { emoji?: { name?: string } }[];
  components?: readonly unknown[];
}

function toMessage(m: DiscordApiMessage): DiscordMessage {
  return {
    id: m.id ?? "",
    channelId: m.channel_id ?? "",
    authorId: m.author?.id ?? "",
    authorIsBot: m.author?.bot === true,
    content: m.content ?? "",
    threadId: m.thread?.id,
    reactionEmoji: (m.reactions ?? []).map((r) => r.emoji?.name ?? "").filter((n) => n.length > 0),
    components: m.components ?? [],
  };
}

function idAfter(id: string, floor: string): boolean {
  try {
    return BigInt(id) > BigInt(floor);
  } catch {
    return false;
  }
}

export class DiscordDriver {
  constructor(private readonly cfg: DiscordDriverConfig) {}

  mention(text: string): string {
    return `<@${this.cfg.botUserId}> ${text}`;
  }

  private async api(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        authorization: `Bot ${this.cfg.token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429) {
      const retry = (await res.json().catch(() => ({}))) as { retry_after?: number };
      await sleep(Math.min((retry.retry_after ?? 1) * 1_000, 10_000));
      return this.api(method, path, body);
    }
    if (!res.ok) throw new Error(`discord ${method} ${path} failed: http ${res.status}`);
    return res.json();
  }

  async post(content: string, channelId: string = this.cfg.channel): Promise<DiscordMessage> {
    const json = (await this.api("POST", `/channels/${channelId}/messages`, { content })) as DiscordApiMessage;
    return toMessage(json);
  }

  async fetchMessage(messageId: string, channelId: string = this.cfg.channel): Promise<DiscordMessage> {
    const json = (await this.api("GET", `/channels/${channelId}/messages/${messageId}`)) as DiscordApiMessage;
    return toMessage(json);
  }

  async messagesAfter(afterId: string, channelId: string = this.cfg.channel): Promise<readonly DiscordMessage[]> {
    const json = (await this.api("GET", `/channels/${channelId}/messages?after=${afterId}&limit=50`)) as DiscordApiMessage[];
    return (Array.isArray(json) ? json : []).map(toMessage);
  }

  isBotReply(m: DiscordMessage): boolean {
    return m.authorId === this.cfg.botUserId;
  }

  async awaitThread(messageId: string, opts: { timeoutMs: number }): Promise<string> {
    return pollUntil(
      async () => (await this.fetchMessage(messageId)).threadId,
      { timeoutMs: opts.timeoutMs, what: `an auto-created thread off message ${messageId}` },
    );
  }

  async awaitReply(channelId: string, afterId: string, opts: { timeoutMs: number }): Promise<DiscordMessage> {
    return pollUntil(
      async () => (await this.messagesAfter(afterId, channelId)).find((m) => this.isBotReply(m) && idAfter(m.id, afterId)),
      { timeoutMs: opts.timeoutMs, what: `a bot reply in channel ${channelId}` },
    );
  }
}
