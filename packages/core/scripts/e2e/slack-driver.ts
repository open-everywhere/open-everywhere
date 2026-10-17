import type { SlackDriverConfig } from "./env.js";
import { backoffDelayMs, pollUntil, sleep } from "./poll.js";

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
  readonly editedTs?: string;
  readonly taskCard?: true;
  readonly blockTexts?: readonly string[];
  readonly approvalCard?: { readonly kind: string; readonly detail: readonly string[] };
  readonly feedbackActionId?: string;
}

export interface SlackApiButton {
  type?: string;
  action_id?: string;
  value?: string;
  text?: string | { text?: string };
}
export interface SlackApiBlock {
  type?: string;
  block_id?: string;
  elements?: readonly SlackApiButton[];
  actions?: readonly SlackApiButton[];
  text?: { text?: string };
}
export interface SlackApiMessage {
  ts?: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  blocks?: readonly SlackApiBlock[];
  files?: readonly { id?: string; name?: string; filetype?: string; mimetype?: string }[];
  edited?: { ts?: string };
  metadata?: { event_type?: string; event_payload?: Record<string, unknown> };
}

export const APPROVAL_CARD_METADATA_TYPE = "oe_approval_card";

export function approvalCardOf(m: Pick<SlackApiMessage, "metadata">): { kind: string; detail: string[] } | undefined {
  if (m.metadata?.event_type !== APPROVAL_CARD_METADATA_TYPE) return undefined;
  const p = m.metadata.event_payload ?? {};
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  if (Array.isArray(p["items"])) {
    const items = (p["items"] as Record<string, unknown>[]).filter((i) => typeof i === "object" && i !== null);
    return { kind: items.map((i) => String(i["kind"] ?? "")).join("+"), detail: items.flatMap((i) => strings(i["detail"])) };
  }
  return typeof p["kind"] === "string" ? { kind: p["kind"], detail: strings(p["detail"]) } : undefined;
}

export function approvalCardFacts(m: Pick<SlackMessage, "text" | "approvalCard">): string {
  return m.approvalCard ? [m.text, m.approvalCard.kind, ...m.approvalCard.detail].join("\n") : m.text;
}

function buttonLabel(b: SlackApiButton): string | undefined {
  if (typeof b.text === "string") return b.text;
  if (b.text && typeof b.text.text === "string") return b.text.text;
  return undefined;
}

export function cardJudgeSurface(message: Pick<SlackMessage, "text" | "actions">): string {
  const labels = (message.actions ?? []).map((a) => a.text?.trim()).filter((t): t is string => !!t);
  return labels.length > 0 ? `${message.text}\nOptions: ${labels.join(" | ")}` : message.text;
}

export const EVE_TASK_CARD_BLOCK_ID_PREFIX = "eve_task_card_";

const EVE_TASK_CARD_BLOCK_TYPES: ReadonlySet<string> = new Set(["task_card", "plan"]);

export function isEveTaskCardBlocks(blocks: readonly { readonly type?: string; readonly block_id?: string }[] | undefined): boolean {
  return (blocks ?? []).some(
    (b) => (b.type !== undefined && EVE_TASK_CARD_BLOCK_TYPES.has(b.type)) || (b.block_id ?? "").startsWith(EVE_TASK_CARD_BLOCK_ID_PREFIX),
  );
}

export function isSettledTaskCard(m: Pick<SlackMessage, "taskCard" | "text">): boolean {
  return m.taskCard === true && m.text.startsWith("Finished ");
}

export function seatMessageSettles(
  m: SlackMessage,
  isBotReply: (m: SlackMessage) => boolean,
  isInterim: ((m: SlackMessage) => boolean) | undefined,
): boolean {
  if (m.taskCard === true) return isSettledTaskCard(m);
  return isBotReply(m) && !(isInterim?.(m) ?? false);
}

export function toMessage(m: SlackApiMessage): SlackMessage {
  const actions = (m.blocks ?? [])
    .flatMap((b) =>
      [...(b.elements ?? []), ...(b.actions ?? [])]
        .filter((e): e is SlackApiButton & { action_id: string } => typeof e.action_id === "string" && e.type !== "feedback_buttons")
        .map((e) => ({ actionId: e.action_id, value: e.value, blockId: b.block_id, text: buttonLabel(e) })),
    );
  const files = (m.files ?? []).map((f) => ({ id: f.id, name: f.name, filetype: f.filetype, mimetype: f.mimetype }));
  const blockTexts = blockTextsOf(m.blocks);
  const approvalCard = approvalCardOf(m);
  const feedback = (m.blocks ?? []).flatMap((b) => b.elements ?? []).find((e) => e.type === "feedback_buttons" && typeof e.action_id === "string");
  return {
    ts: m.ts ?? "",
    threadTs: m.thread_ts,
    userId: m.user,
    botId: m.bot_id,
    text: m.text ?? "",
    actions: actions.length > 0 ? actions : undefined,
    files: files.length > 0 ? files : undefined,
    editedTs: m.edited?.ts,
    ...(isEveTaskCardBlocks(m.blocks) ? { taskCard: true as const } : {}),
    ...(blockTexts.length > 0 ? { blockTexts } : {}),
    ...(approvalCard ? { approvalCard } : {}),
    ...(feedback?.action_id ? { feedbackActionId: feedback.action_id } : {}),
  };
}

export function blockTextsOf(blocks: readonly SlackApiBlock[] | undefined): string[] {
  const out: string[] = [];
  for (const b of blocks ?? []) {
    const t =
      b.type === "header" || b.type === "section"
        ? b.text?.text
        : b.type === "context"
          ? (b.elements ?? []).map(buttonLabel).filter((x): x is string => typeof x === "string").join(" ")
          : undefined;
    if (typeof t === "string" && t.length > 0) out.push(t);
  }
  return out;
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

export function tsAfter(ts: string, floor: string): boolean {
  return Number.parseFloat(ts) > Number.parseFloat(floor);
}

export const DEFAULT_QUALIFYING_EDIT_WINDOW_MS = 600_000;

export function isQualifyingEdit(m: SlackMessage, maxDelayMs: number = DEFAULT_QUALIFYING_EDIT_WINDOW_MS): boolean {
  if (!m.editedTs) return false;
  const delayMs = (Number.parseFloat(m.editedTs) - Number.parseFloat(m.ts)) * 1000;
  return delayMs >= 0 && delayMs <= maxDelayMs;
}

export function passesSkip(m: SlackMessage, skip: ((m: SlackMessage) => boolean) | undefined): boolean {
  if (m.taskCard === true) return false;
  return !(skip?.(m) ?? false) || isQualifyingEdit(m);
}

export function endsOwnWakeWait(m: SlackMessage, skip: ((m: SlackMessage) => boolean) | undefined, want: ((m: SlackMessage) => boolean) | undefined): boolean {
  return passesSkip(m, skip) && (want?.(m) ?? true);
}

export interface SteppedOverMessage {
  readonly text: string;
  readonly editedTs?: string;
}

export function nextReplyCandidate(
  msgs: readonly SlackMessage[],
  opts: {
    readonly floorTs: string;
    readonly steppedOver: ReadonlyMap<string, SteppedOverMessage>;
    readonly isBotReply: (m: SlackMessage) => boolean;
    readonly skip?: (m: SlackMessage) => boolean;
  },
): SlackMessage | undefined {
  return msgs.find((m) => {
    if (!opts.isBotReply(m) || !passesSkip(m, opts.skip)) return false;
    const seen = opts.steppedOver.get(m.ts);
    if (seen !== undefined) return seen.text !== m.text || seen.editedTs !== m.editedTs;
    return tsAfter(m.ts, opts.floorTs);
  });
}

export function mergeBotMessagesAfter(
  threadMsgs: readonly SlackMessage[],
  historyMsgs: readonly SlackMessage[],
  afterTs: string,
  isBot: (m: SlackMessage) => boolean,
): readonly SlackMessage[] {
  const byTs = new Map<string, SlackMessage>();
  for (const m of [...threadMsgs, ...historyMsgs]) {
    if (!isBot(m) || !tsAfter(m.ts, afterTs)) continue;
    byTs.set(m.ts, m);
  }
  return [...byTs.values()].sort((a, b) => Number.parseFloat(a.ts) - Number.parseFloat(b.ts));
}

export function findExactBotPost(
  threadMsgs: readonly SlackMessage[],
  historyMsgs: readonly SlackMessage[],
  afterTs: string,
  text: string,
  isBot: (m: SlackMessage) => boolean,
): SlackMessage | undefined {
  return mergeBotMessagesAfter(threadMsgs, historyMsgs, afterTs, isBot).find((m) => m.text.trim() === text);
}

export interface SeatFenceState {
  readonly newestTs: string | undefined;
  readonly settles: boolean;
  readonly seenAtMs: number;
}

export type SeatFenceVerdict = "owed" | "settling" | "quiet";

export function seatFenceStep(input: {
  readonly prev: SeatFenceState | undefined;
  readonly newest: { readonly ts: string; readonly settles: boolean } | undefined;
  readonly nowMs: number;
  readonly quietMs: number;
  readonly owedGraceMs: number;
}): { readonly state: SeatFenceState; readonly verdict: SeatFenceVerdict; readonly abandoned: boolean } {
  const newestTs = input.newest?.ts;
  const abandoned =
    input.newest !== undefined &&
    !input.newest.settles &&
    input.nowMs - Number.parseFloat(input.newest.ts) * 1000 > input.owedGraceMs;
  const settles = input.newest === undefined || input.newest.settles || abandoned;
  const state: SeatFenceState =
    input.prev !== undefined && input.prev.newestTs === newestTs && input.prev.settles === settles
      ? input.prev
      : { newestTs, settles, seenAtMs: input.nowMs };
  if (!settles) return { state, verdict: "owed", abandoned };
  return { state, verdict: input.nowMs - state.seenAtMs >= input.quietMs ? "quiet" : "settling", abandoned };
}

export interface SeatFenceResult {
  readonly quiet: boolean;
  readonly verdict: SeatFenceVerdict;
  readonly anchorTs: string | undefined;
  readonly abandoned: boolean;
  readonly waitedMs: number;
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

  async apiRaw(method: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.cfg.token}`,
        "content-type": "application/x-www-form-urlencoded; charset=utf-8",
      },
      body: new URLSearchParams(params).toString(),
    });
    return (await res.json()) as Record<string, unknown>;
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
    await this.uploadFile(input);
  }

  async uploadFile(input: { filename: string; bytes: Uint8Array; title?: string; threadTs?: string; initialComment?: string }): Promise<{ fileId: string }> {
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
    return { fileId };
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
    const json = await this.api("conversations.replies", { channel: this.cfg.channel, ts: rootTs, limit: "50", include_all_metadata: "true" });
    const msgs = Array.isArray(json.messages) ? (json.messages as SlackApiMessage[]) : [];
    return msgs.map(toMessage);
  }

  async latest(limit = 1): Promise<readonly SlackMessage[]> {
    const json = await this.api("conversations.history", { channel: this.cfg.channel, limit: String(limit), include_all_metadata: "true" });
    const msgs = Array.isArray(json.messages) ? (json.messages as SlackApiMessage[]) : [];
    return msgs.map(toMessage);
  }

  async awaitSeatQuiet(opts: {
    readonly quietMs: number;
    readonly timeoutMs: number;
    readonly owedGraceMs: number;
    readonly isInterim?: (m: SlackMessage) => boolean;
  }): Promise<SeatFenceResult> {
    const started = Date.now();
    let state: SeatFenceState | undefined;
    let verdict: SeatFenceVerdict = "settling";
    let abandoned = false;
    for (let attempt = 0; ; attempt++) {
      const [newest] = await this.latest(1);
      const step = seatFenceStep({
        prev: state,
        newest: newest
          ? { ts: newest.ts, settles: seatMessageSettles(newest, (m) => this.isBotReply(m), opts.isInterim) }
          : undefined,
        nowMs: Date.now(),
        quietMs: opts.quietMs,
        owedGraceMs: opts.owedGraceMs,
      });
      state = step.state;
      verdict = step.verdict;
      abandoned = step.abandoned;
      const elapsed = Date.now() - started;
      if (verdict === "quiet") return { quiet: true, verdict, anchorTs: state.newestTs, abandoned, waitedMs: elapsed };
      if (elapsed >= opts.timeoutMs) return { quiet: false, verdict, anchorTs: state.newestTs, abandoned, waitedMs: elapsed };
      await sleep(Math.min(backoffDelayMs(attempt), opts.timeoutMs - elapsed));
    }
  }

  async history(oldestTs: string): Promise<readonly SlackMessage[]> {
    const json = await this.api("conversations.history", {
      channel: this.cfg.channel,
      oldest: oldestTs,
      inclusive: "false",
      limit: "50",
      include_all_metadata: "true",
    });
    const msgs = Array.isArray(json.messages) ? (json.messages as SlackApiMessage[]) : [];
    return msgs.map(toMessage);
  }

  isBotMessage(m: SlackMessage): boolean {
    return m.userId === this.cfg.botUserId || (m.botId !== undefined && m.userId === undefined);
  }

  isBotReply(m: SlackMessage): boolean {
    return this.isBotMessage(m) && m.taskCard !== true;
  }

  async awaitThreadReply(
    rootTs: string,
    opts: { afterTs?: string; timeoutMs: number; skip?: (m: SlackMessage) => boolean },
  ): Promise<SlackMessage> {
    const floor = opts.afterTs ?? rootTs;
    return pollUntil(
      async () =>
        (await this.replies(rootTs)).find(
          (m) => this.isBotReply(m) && tsAfter(m.ts, floor) && passesSkip(m, opts.skip),
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
    const wanted = (m: SlackMessage): boolean => this.isBotReply(m) && passesSkip(m, opts.skip);
    return pollUntil(
      async () => {
        const threaded = (await this.replies(anchorTs)).find((m) => wanted(m) && tsAfter(m.ts, anchorTs));
        if (threaded) return threaded;
        return (await this.history(anchorTs)).find(wanted);
      },
      { timeoutMs: opts.timeoutMs, what: `a bot reply (threaded or top-level) after ${anchorTs}` },
    );
  }

  async collectRepliesDuring(rootTs: string, afterTs: string, windowMs: number): Promise<readonly SlackMessage[]> {
    await sleep(windowMs);
    return (await this.replies(rootTs)).filter((m) => this.isBotMessage(m) && tsAfter(m.ts, afterTs));
  }

  async collectBotMessagesAfter(
    rootTs: string,
    afterTs: string,
    opts: { readonly includeTaskCards?: boolean } = {},
  ): Promise<readonly SlackMessage[]> {
    const [threadMsgs, historyMsgs] = await Promise.all([this.replies(rootTs), this.history(afterTs)]);
    const isBot = opts.includeTaskCards === true ? (m: SlackMessage) => this.isBotMessage(m) : (m: SlackMessage) => this.isBotReply(m);
    return mergeBotMessagesAfter(threadMsgs, historyMsgs, afterTs, isBot);
  }

  async awaitExactBotPost(anchorTs: string, text: string, opts: { timeoutMs: number; what: string }): Promise<SlackMessage> {
    return pollUntil(
      async () => {
        const [threadMsgs, historyMsgs] = await Promise.all([this.replies(anchorTs), this.history(anchorTs)]);
        return findExactBotPost(threadMsgs, historyMsgs, anchorTs, text, (m) => this.isBotReply(m));
      },
      { timeoutMs: opts.timeoutMs, what: opts.what },
    );
  }

  async reactions(ts: string): Promise<readonly string[]> {
    const json = await this.api("reactions.get", { channel: this.cfg.channel, timestamp: ts });
    const message = (json.message ?? {}) as { reactions?: readonly { name?: string }[] };
    return (message.reactions ?? []).map((r) => r.name ?? "").filter((n) => n.length > 0);
  }
}
