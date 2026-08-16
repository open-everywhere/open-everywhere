import type { SlackDriverConfig } from "./env.js";
import { pollUntil, sleep } from "./poll.js";

export interface SlackMessageAction {
  readonly actionId: string;
  readonly value?: string;
  readonly blockId?: string;
  readonly text?: string;
}

export interface SlackFile {
  readonly id?: string;
  readonly name?: string;
  readonly filetype?: string;
  readonly mimetype?: string;
}

export interface SlackMessage {
  readonly ts: string;
  readonly threadTs?: string;
  readonly userId?: string;
  readonly botId?: string;
  readonly text: string;
  readonly actions?: readonly SlackMessageAction[];
  readonly files?: readonly SlackFile[];
}

interface SlackApiButton {
  action_id?: string;
  value?: string;
  text?: string | { text?: string };
}
interface SlackApiBlock {
  type?: string;
  block_id?: string;
  elements?: readonly SlackApiButton[];
  actions?: readonly SlackApiButton[];
}
interface SlackApiMessage {
  ts?: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  blocks?: readonly SlackApiBlock[];
  files?: readonly { id?: string; name?: string; filetype?: string; mimetype?: string }[];
}

function buttonLabel(b: SlackApiButton): string | undefined {
  if (typeof b.text === "string") return b.text;
  if (b.text && typeof b.text.text === "string") return b.text.text;
  return undefined;
}

function toMessage(m: SlackApiMessage): SlackMessage {
  const actions = (m.blocks ?? [])
    .flatMap((b) =>
      [...(b.elements ?? []), ...(b.actions ?? [])]
        .filter((e): e is SlackApiButton & { action_id: string } => typeof e.action_id === "string")
        .map((e) => ({ actionId: e.action_id, value: e.value, blockId: b.block_id, text: buttonLabel(e) })),
    );
  const files = (m.files ?? []).map((f) => ({ id: f.id, name: f.name, filetype: f.filetype, mimetype: f.mimetype }));
  return {
    ts: m.ts ?? "",
    threadTs: m.thread_ts,
    userId: m.user,
    botId: m.bot_id,
    text: m.text ?? "",
    actions: actions.length > 0 ? actions : undefined,
    files: files.length > 0 ? files : undefined,
  };
}

export function buildChatUpdateBody(input: { channel: string; ts: string; text: string }): string {
  return new URLSearchParams({ channel: input.channel, ts: input.ts, text: input.text }).toString();
}

export function buildUploadUrlBody(input: { filename: string; length: number }): string {
  return new URLSearchParams({ filename: input.filename, length: String(input.length) }).toString();
}

export function buildCompleteUploadBody(input: {
  fileId: string;
  title: string;
  channel: string;
  threadTs?: string;
  initialComment?: string;
}): string {
  const params: Record<string, string> = {
    files: JSON.stringify([{ id: input.fileId, title: input.title }]),
    channel_id: input.channel,
  };
  if (input.threadTs) params.thread_ts = input.threadTs;
  if (input.initialComment) params.initial_comment = input.initialComment;
  return new URLSearchParams(params).toString();
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

  get channelId(): string {
    return this.cfg.channel;
  }

  get botUserId(): string {
    return this.cfg.botUserId;
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

  async isMember(userId: string): Promise<boolean> {
    const json = await this.api("conversations.members", { channel: this.cfg.channel, limit: "100" });
    const members = Array.isArray(json.members) ? (json.members as string[]) : [];
    return members.includes(userId);
  }

  async openDirectMessage(userId: string): Promise<string> {
    const json = await this.api("conversations.open", { users: userId });
    const channel = json.channel as { id?: string } | undefined;
    const id = typeof channel?.id === "string" ? channel.id : undefined;
    if (!id) throw new Error("slack conversations.open returned no channel.id");
    return id;
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

  async update(ts: string, text: string): Promise<void> {
    await this.api("chat.update", { channel: this.cfg.channel, ts, text });
  }

  async uploadImage(input: { filename: string; bytes: Uint8Array; title?: string; threadTs?: string; initialComment?: string }): Promise<void> {
    const title = input.title ?? input.filename;
    const step1 = await this.api("files.getUploadURLExternal", Object.fromEntries(new URLSearchParams(buildUploadUrlBody({ filename: input.filename, length: input.bytes.byteLength }))));
    const uploadUrl = typeof step1.upload_url === "string" ? step1.upload_url : "";
    const fileId = typeof step1.file_id === "string" ? step1.file_id : "";
    if (!uploadUrl || !fileId) throw new Error("slack files.getUploadURLExternal returned no upload_url/file_id");
    const put = await fetch(uploadUrl, { method: "POST", body: input.bytes });
    if (!put.ok) throw new Error(`slack file byte upload failed: http ${put.status}`);
    await this.api(
      "files.completeUploadExternal",
      Object.fromEntries(new URLSearchParams(buildCompleteUploadBody({ fileId, title, channel: this.cfg.channel, threadTs: input.threadTs, initialComment: input.initialComment }))),
    );
  }

  async awaitFileReply(rootTs: string, opts: { timeoutMs: number; filetype?: string; afterTs?: string }): Promise<SlackMessage> {
    const floor = opts.afterTs ?? rootTs;
    return pollUntil(
      async () =>
        (await this.replies(rootTs)).find(
          (m) =>
            this.isBotReply(m) &&
            tsAfter(m.ts, floor) &&
            (m.files?.length ?? 0) > 0 &&
            (opts.filetype === undefined || (m.files ?? []).some((f) => f.filetype === opts.filetype)),
        ),
      { timeoutMs: opts.timeoutMs, what: `a bot reply carrying a ${opts.filetype ?? "file"} attachment in thread ${rootTs}` },
    );
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

  async awaitThreadReply(
    rootTs: string,
    opts: { afterTs?: string; timeoutMs: number; skip?: (m: SlackMessage) => boolean },
  ): Promise<SlackMessage> {
    const floor = opts.afterTs ?? rootTs;
    return pollUntil(
      async () =>
        (await this.replies(rootTs)).find(
          (m) => this.isBotReply(m) && tsAfter(m.ts, floor) && !(opts.skip?.(m) ?? false),
        ),
      { timeoutMs: opts.timeoutMs, what: `a substantive bot reply in thread ${rootTs}` },
    );
  }

  async awaitThreadMessage(
    rootTs: string,
    opts: { timeoutMs: number; what: string },
    find: (msgs: readonly SlackMessage[]) => SlackMessage | undefined,
  ): Promise<SlackMessage> {
    return pollUntil(async () => find(await this.replies(rootTs)), { timeoutMs: opts.timeoutMs, what: opts.what });
  }

  async awaitAnyReply(anchorTs: string, opts: { timeoutMs: number; skip?: (m: SlackMessage) => boolean }): Promise<SlackMessage> {
    const wanted = (m: SlackMessage): boolean => this.isBotReply(m) && !(opts.skip?.(m) ?? false);
    return pollUntil(
      async () => {
        const threaded = (await this.replies(anchorTs)).find((m) => wanted(m) && tsAfter(m.ts, anchorTs));
        if (threaded) return threaded;
        return (await this.history(anchorTs)).find(wanted);
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
