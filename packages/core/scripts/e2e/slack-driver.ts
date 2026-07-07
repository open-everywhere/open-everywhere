import type { SlackDriverConfig } from "./env.js";
import { pollUntil, sleep } from "./poll.js";

export interface SlackMessage {
  readonly ts: string;
  readonly threadTs?: string;
  readonly userId?: string;
  readonly botId?: string;
  readonly text: string;
}

interface SlackApiMessage {
  ts?: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  text?: string;
}

function toMessage(m: SlackApiMessage): SlackMessage {
  return { ts: m.ts ?? "", threadTs: m.thread_ts, userId: m.user, botId: m.bot_id, text: m.text ?? "" };
}

function tsAfter(ts: string, floor: string): boolean {
  return Number.parseFloat(ts) > Number.parseFloat(floor);
}

export class SlackDriver {
  private identityCache?: { userId: string; teamId: string };

  constructor(private readonly cfg: SlackDriverConfig) {}

  mention(text: string): string {
    return `<@${this.cfg.botUserId}> ${text}`;
  }

  withChannel(channel: string): SlackDriver {
    return new SlackDriver({ ...this.cfg, channel });
  }

  async identity(): Promise<{ userId: string; teamId: string }> {
    if (!this.identityCache) {
      const json = await this.api("auth.test", {});
      const userId = typeof json.user_id === "string" ? json.user_id : "";
      const teamId = typeof json.team_id === "string" ? json.team_id : "";
      if (!userId || !teamId) throw new Error("slack auth.test returned no user_id/team_id");
      this.identityCache = { userId, teamId };
    }
    return this.identityCache;
  }

  private async api(method: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.cfg.token}`,
        "content-type": "application/x-www-form-urlencoded; charset=utf-8",
      },
      body: new URLSearchParams(params).toString(),
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (json.ok !== true) {
      throw new Error(`slack ${method} failed: ${String(json.error ?? `http ${res.status}`)}`);
    }
    return json;
  }

  async post(text: string, threadTs?: string): Promise<{ ts: string }> {
    const params: Record<string, string> = { channel: this.cfg.channel, text };
    if (threadTs) params.thread_ts = threadTs;
    const json = await this.api("chat.postMessage", params);
    const ts = typeof json.ts === "string" ? json.ts : undefined;
    if (!ts) throw new Error("slack chat.postMessage returned no ts");
    return { ts };
  }

  async replies(rootTs: string): Promise<readonly SlackMessage[]> {
    const json = await this.api("conversations.replies", { channel: this.cfg.channel, ts: rootTs, limit: "50" });
    const msgs = Array.isArray(json.messages) ? (json.messages as SlackApiMessage[]) : [];
    return msgs.map(toMessage);
  }

  async history(oldestTs: string): Promise<readonly SlackMessage[]> {
    const json = await this.api("conversations.history", {
      channel: this.cfg.channel,
      oldest: oldestTs,
      inclusive: "false",
      limit: "50",
    });
    const msgs = Array.isArray(json.messages) ? (json.messages as SlackApiMessage[]) : [];
    return msgs.map(toMessage);
  }

  isBotReply(m: SlackMessage): boolean {
    return m.userId === this.cfg.botUserId || (m.botId !== undefined && m.userId === undefined);
  }

  async awaitThreadReply(rootTs: string, opts: { afterTs?: string; timeoutMs: number }): Promise<SlackMessage> {
    const floor = opts.afterTs ?? rootTs;
    return pollUntil(
      async () => (await this.replies(rootTs)).find((m) => this.isBotReply(m) && tsAfter(m.ts, floor)),
      { timeoutMs: opts.timeoutMs, what: `a bot reply in thread ${rootTs}` },
    );
  }

  async awaitAnyReply(anchorTs: string, opts: { timeoutMs: number }): Promise<SlackMessage> {
    return pollUntil(
      async () => {
        const threaded = (await this.replies(anchorTs)).find((m) => this.isBotReply(m) && tsAfter(m.ts, anchorTs));
        if (threaded) return threaded;
        return (await this.history(anchorTs)).find((m) => this.isBotReply(m));
      },
      { timeoutMs: opts.timeoutMs, what: `a bot reply (threaded or top-level) after ${anchorTs}` },
    );
  }

  async awaitChannelMessage(afterTs: string, opts: { timeoutMs: number }): Promise<SlackMessage> {
    return pollUntil(
      async () => (await this.history(afterTs)).find((m) => this.isBotReply(m)),
      { timeoutMs: opts.timeoutMs, what: `a bot message in channel after ${afterTs}` },
    );
  }

  async collectRepliesDuring(rootTs: string, afterTs: string, windowMs: number): Promise<readonly SlackMessage[]> {
    await sleep(windowMs);
    return (await this.replies(rootTs)).filter((m) => this.isBotReply(m) && tsAfter(m.ts, afterTs));
  }

  async reactions(ts: string): Promise<readonly string[]> {
    const json = await this.api("reactions.get", { channel: this.cfg.channel, timestamp: ts });
    const message = (json.message ?? {}) as { reactions?: readonly { name?: string }[] };
    return (message.reactions ?? []).map((r) => r.name ?? "").filter((n) => n.length > 0);
  }
}
