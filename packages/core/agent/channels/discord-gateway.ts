import { defineChannel, POST } from "eve/channels";
import { buildDiscordAuth, type OpenEverywhereDiscordAuth } from "./discord-identity.js";
import { finalMessageAction, NO_REPLY_SENTINEL, type FinalMessageAction } from "./slack-events.js";
import { verifyWebhookSignature } from "../webhooks/gate.js";
import { resolvePartition, type Partition } from "../memory/partition.js";
import { bindFrom, type BindableContext } from "../identity/binding.js";
import { isThreadEngaged, markThreadEngaged } from "./engagement.js";
import { scopeOverBudget } from "../spend/check.js";
import { consumeCardPostedThisTurn, peekCardPostedThisTurn } from "../approvals/card-signal.js";

function log(msg: string): void {
  console.log(`[open-everywhere:discord-gateway] ${msg}`);
}

export interface DiscordGatewayState {
  channelId: string;
  originalChannelId?: string;
  originalMessageId?: string;
}
interface DiscordGatewayContext {
  readonly channelId: string;
  readonly state: DiscordGatewayState;
}

export interface DiscordRelayMessage {
  readonly id: string;
  readonly content: string;
  readonly channelId: string;
  readonly channelType?: string;
  readonly guildId?: string;
  readonly author: { readonly id: string; readonly username?: string; readonly bot: boolean };
  readonly mentionsBot: boolean;
  readonly referencedMessageId?: string;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function strOrNum(v: unknown): string | undefined {
  if (typeof v === "string") return v.length > 0 ? v : undefined;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return undefined;
}

export function parseRelayPayload(raw: unknown): DiscordRelayMessage | null {
  if (!isObject(raw)) return null;
  if (raw["source"] !== "discord-gateway-relay") return null;
  const m = raw["message"];
  if (!isObject(m)) return null;
  const channelId = str(m["channelId"]);
  const author = isObject(m["author"]) ? (m["author"] as Record<string, unknown>) : undefined;
  const authorId = author ? str(author["id"]) : undefined;
  if (!channelId || !authorId) return null;
  return {
    id: str(m["id"]) ?? "",
    content: typeof m["content"] === "string" ? (m["content"] as string) : "",
    channelId,
    channelType: strOrNum(m["channelType"]),
    guildId: str(m["guildId"]),
    author: { id: authorId, username: str(author!["username"]), bot: author!["bot"] === true },
    mentionsBot: m["mentionsBot"] === true,
    referencedMessageId: str(m["referencedMessageId"]),
  };
}

export interface RelayRejection {
  readonly status: number;
  readonly reason: string;
}

export function relayGate(
  signatureHeader: string | null,
  rawBody: string,
  secret: string | undefined = process.env.OE_RELAY_SECRET,
): RelayRejection | null {
  if (!secret) {
    return { status: 401, reason: "OE_RELAY_SECRET is not set — rejecting unverified relay delivery" };
  }
  if (!verifyWebhookSignature(secret, rawBody, signatureHeader)) {
    return { status: 401, reason: "invalid relay signature" };
  }
  return null;
}

export function authForRelayMessage(msg: DiscordRelayMessage): OpenEverywhereDiscordAuth | null {
  if (msg.author.bot) return null;
  return buildDiscordAuth({
    userId: msg.author.id,
    guildId: msg.guildId,
    channelId: msg.channelId,
    channelType: msg.channelType,
  });
}

function ctxFromAuth(auth: OpenEverywhereDiscordAuth): BindableContext {
  return { channel: { kind: "discord" }, session: { auth: { current: auth } } };
}

export function isDmChannel(channelType: string | undefined): boolean {
  return channelType === "1" || channelType === "3";
}

export function shouldDispatchDiscord(input: {
  readonly mentionsBot: boolean;
  readonly isEngaged: boolean;
  readonly isDm: boolean;
}): boolean {
  return input.isDm || input.mentionsBot || input.isEngaged;
}

function engagementKey(msg: DiscordRelayMessage): string {
  return msg.channelId;
}

export function renderTurn(direct: boolean, content: string): string {
  if (direct) return content;
  return [
    `[thread-follow] You were not mentioned — this message reached you because you're following ` +
      `this Discord channel. Reply only if it warrants a response from you: it's addressed to you, ` +
      `asks you something, or moves the task you're working on. If the humans are talking among ` +
      `themselves and your reply would be noise, output exactly ${NO_REPLY_SENTINEL} and nothing ` +
      `else — nothing will be posted.`,
    "",
    content,
  ].join("\n");
}

export function splitForDiscord(text: string, max = 2000): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut <= 0) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

function botAuthHeaders(token: string): Record<string, string> {
  return { authorization: `Bot ${token}`, "content-type": "application/json" };
}

async function discordCreateMessage(channelId: string, content: string): Promise<string | null> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    log(`DISCORD_BOT_TOKEN is not set — cannot post to channel ${channelId}`);
    return null;
  }
  if (!channelId) {
    log("no channel id — nothing to post to");
    return null;
  }
  try {
    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: botAuthHeaders(token),
      body: JSON.stringify({ content }),
    });
    if (!res.ok) {
      log(`Discord create-message failed (${res.status}) for channel ${channelId}`);
      return null;
    }
    const body = (await res.json()) as unknown;
    return isObject(body) ? (str(body["id"]) ?? null) : null;
  } catch (err) {
    log(`Discord create-message error for channel ${channelId}: ${(err as Error)?.message ?? String(err)}`);
    return null;
  }
}

async function postDiscordReply(channelId: string, text: string): Promise<void> {
  for (const chunk of splitForDiscord(text)) {
    await discordCreateMessage(channelId, chunk);
  }
}

const lastTypingAt = new Map<string, number>();
const TYPING_REFRESH_MS = 7_000;

export function typingRefreshDue(
  channelId: string,
  nowMs: number = Date.now(),
  state: Map<string, number> = lastTypingAt,
): boolean {
  const last = state.get(channelId);
  if (last !== undefined && nowMs - last < TYPING_REFRESH_MS) return false;
  state.set(channelId, nowMs);
  return true;
}

async function triggerDiscordTyping(channelId: string): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token || !channelId) return;
  try {
    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/typing`, {
      method: "POST",
      headers: { authorization: `Bot ${token}` },
    });
    if (!res.ok) {
      log(`Discord typing trigger failed (${res.status}) for channel ${channelId}`);
    }
  } catch (err) {
    log(`Discord typing trigger error for channel ${channelId}: ${(err as Error)?.message ?? String(err)}`);
  }
}

const EYES_EMOJI = "👀";

async function setDiscordReaction(
  channelId: string,
  messageId: string,
  emoji: string,
  action: "PUT" | "DELETE",
): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) return;
  if (!channelId || !messageId) return;
  const encoded = encodeURIComponent(emoji);
  try {
    const res = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}/reactions/${encoded}/@me`,
      { method: action, headers: { authorization: `Bot ${token}` } },
    );
    if (!res.ok && !(action === "DELETE" && res.status === 404)) {
      log(`Discord reaction ${action} failed (${res.status}) for message ${messageId} in channel ${channelId}`);
    }
  } catch (err) {
    log(`Discord reaction ${action} error for channel ${channelId}: ${(err as Error)?.message ?? String(err)}`);
  }
}

export function shouldAutoThread(channelType: string | undefined, enabled: boolean): boolean {
  if (!enabled) return false;
  return channelType === "0" || channelType === "5";
}

export function autoThreadEnabled(env: string | undefined = process.env.OE_DISCORD_AUTO_THREAD): boolean {
  return env !== "false" && env !== "0";
}

export function statusUxEnabled(env: string | undefined = process.env.OE_DISCORD_STATUS_UX): boolean {
  return env !== "false" && env !== "0";
}

export function deriveThreadName(content: string, botName?: string): string {
  const fallback = `Conversation with ${botName ?? "the agent"}`;
  const cleaned = content.replace(/^\s*<@!?[^>]+>\s*/, "").replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return fallback;
  if (cleaned.length <= 100) return cleaned;
  const hard = cleaned.slice(0, 100);
  const lastSpace = hard.lastIndexOf(" ");
  return (lastSpace >= 80 ? hard.slice(0, lastSpace) : hard).trim();
}

async function createDiscordThread(channelId: string, messageId: string, name: string): Promise<string | null> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    log(`DISCORD_BOT_TOKEN is not set — cannot create thread on channel ${channelId}`);
    return null;
  }
  if (!channelId || !messageId) {
    log("createDiscordThread: missing channel/message id — cannot create thread");
    return null;
  }
  try {
    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}/threads`, {
      method: "POST",
      headers: {
        authorization: `Bot ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name, auto_archive_duration: 1440 }),
    });
    if (!res.ok) {
      log(`Discord create-thread failed (${res.status}) for channel ${channelId} — falling back to inline`);
      return null;
    }
    const body = (await res.json()) as unknown;
    const id = isObject(body) ? str(body["id"]) : undefined;
    if (!id) {
      log(`Discord create-thread returned no thread id for channel ${channelId} — falling back to inline`);
      return null;
    }
    return id;
  } catch (err) {
    log(`Discord create-thread error for channel ${channelId}: ${(err as Error)?.message ?? String(err)}`);
    return null;
  }
}

export function dispatchSurfaceFor(
  msg: DiscordRelayMessage,
  baseAuth: OpenEverywhereDiscordAuth,
  threadId: string | null,
): { auth: OpenEverywhereDiscordAuth; continuationToken: string; state: DiscordGatewayState; engagementKey: string } {
  if (threadId) {
    const auth = buildDiscordAuth({
      userId: msg.author.id,
      guildId: msg.guildId,
      channelId: threadId,
      channelType: "11",
    });
    return { auth, continuationToken: `discord:${threadId}`, state: { channelId: threadId }, engagementKey: threadId };
  }
  return {
    auth: baseAuth,
    continuationToken: `discord:${msg.channelId}`,
    state: { channelId: msg.channelId },
    engagementKey: msg.channelId,
  };
}

export type ReactionResolution =
  | "clear"
  | "none";

export type CompletionDelivery =
  | { readonly kind: "post"; readonly chunks: readonly string[] }
  | { readonly kind: "none" };

export interface CompletionPlan {
  readonly reaction: ReactionResolution;
  readonly delivery: CompletionDelivery;
}

export function planCompletion(input: {
  readonly action: FinalMessageAction;
  readonly reactionActive: boolean;
  readonly cardPostedThisTurn?: boolean;
}): CompletionPlan {
  const { action, reactionActive, cardPostedThisTurn } = input;
  if (action.kind === "buffer-tool-status") {
    return { reaction: "none", delivery: { kind: "none" } };
  }
  if (action.kind === "post") {
    return {
      reaction: reactionActive ? "clear" : "none",
      delivery: cardPostedThisTurn ? { kind: "none" } : { kind: "post", chunks: splitForDiscord(action.text) },
    };
  }
  return {
    reaction: reactionActive ? "clear" : "none",
    delivery: { kind: "none" },
  };
}

export function buildGatewayState(input: {
  readonly replyChannelId: string;
  readonly original?: { readonly channelId: string; readonly messageId: string };
}): DiscordGatewayState {
  return {
    channelId: input.replyChannelId,
    originalChannelId: input.original?.channelId,
    originalMessageId: input.original?.messageId,
  };
}

export function takeTurnStatus(state: DiscordGatewayState): {
  original?: { channelId: string; messageId: string };
} {
  const original =
    state.originalChannelId && state.originalMessageId
      ? { channelId: state.originalChannelId, messageId: state.originalMessageId }
      : undefined;
  state.originalChannelId = undefined;
  state.originalMessageId = undefined;
  return { original };
}

type DiscordGatewaySend = (
  message: string,
  options: {
    auth: OpenEverywhereDiscordAuth;
    continuationToken: string;
    state: DiscordGatewayState;
  },
) => Promise<unknown>;

async function dispatchTurn(
  msg: DiscordRelayMessage,
  auth: OpenEverywhereDiscordAuth,
  send: DiscordGatewaySend,
  createThread: (channelId: string, messageId: string, name: string) => Promise<string | null> = createDiscordThread,
): Promise<void> {
  const partition: Partition = resolvePartition(ctxFromAuth(auth));
  const key = engagementKey(msg);
  const isDm = isDmChannel(msg.channelType);
  const engaged = isDm || msg.mentionsBot ? true : await isThreadEngaged(partition, key);
  if (!shouldDispatchDiscord({ mentionsBot: msg.mentionsBot, isEngaged: engaged, isDm })) {
    log(`drop ${partition.surfaceKey}: non-mention in a channel the agent isn't following`);
    return;
  }

  try {
    const verdict = await scopeOverBudget(partition, bindFrom(ctxFromAuth(auth)).mode, new Date().toISOString());
    if (verdict.over) {
      await discordCreateMessage(
        msg.channelId,
        `⛔ I'm holding off here — ${verdict.reason}. An admin can raise this permanently in the ` +
          `spend-budgets config, or DM me to propose a temporary override for this channel ` +
          `(set_spend_limit) — an admin approves it on a card.`,
      );
      log(`declined ${partition.surfaceKey}: over budget (${verdict.reason ?? "over cap"})`);
      return;
    }
  } catch {
  }

  const statusUx = statusUxEnabled();
  let threadId: string | null = null;
  if (msg.mentionsBot && shouldAutoThread(msg.channelType, autoThreadEnabled())) {
    threadId = await createThread(msg.channelId, msg.id, deriveThreadName(msg.content));
    if (!threadId) {
      log(`auto-thread failed for ${partition.surfaceKey} — falling back to an inline reply in the base channel`);
    }
  }

  if (statusUx && (msg.mentionsBot || isDm)) {
    await setDiscordReaction(msg.channelId, msg.id, EYES_EMOJI, "PUT");
  }

  const surface = dispatchSurfaceFor(msg, auth, threadId);
  const dispatchPartition: Partition = threadId ? resolvePartition(ctxFromAuth(surface.auth)) : partition;

  if (msg.mentionsBot) {
    await markThreadEngaged(dispatchPartition, surface.engagementKey, new Date().toISOString());
  }
  const turnState: DiscordGatewayState = buildGatewayState({
    replyChannelId: surface.state.channelId,
    original: statusUx && threadId ? { channelId: msg.channelId, messageId: msg.id } : undefined,
  });

  if (statusUx) {
    await triggerDiscordTyping(surface.state.channelId);
  }

  await send(renderTurn(msg.mentionsBot || isDm, msg.content), {
    auth: surface.auth,
    continuationToken: surface.continuationToken,
    state: turnState,
  });
  log(
    `dispatched ${dispatchPartition.surfaceKey} (${isDm ? "dm" : msg.mentionsBot ? "mention" : "engaged"}` +
      `${threadId ? ", auto-threaded+👀" : ""})`,
  );
}

export default defineChannel<DiscordGatewayState, DiscordGatewayContext>({
  kindHint: "discord",
  state: { channelId: "" },
  context: (state: DiscordGatewayState): DiscordGatewayContext => ({
    channelId: state.channelId,
    state,
  }),
  routes: [
    POST<DiscordGatewayState>("/eve/v1/discord-gateway", async (req, { send, waitUntil }) => {
      const rawBody = await req.text();

      const rejection = relayGate(req.headers.get("x-oe-relay-signature"), rawBody);
      if (rejection) {
        log(`rejected (${rejection.status}): ${rejection.reason}`);
        return new Response(rejection.reason, { status: rejection.status });
      }

      let json: unknown;
      try {
        json = JSON.parse(rawBody);
      } catch {
        return new Response("invalid json", { status: 400 });
      }
      const msg = parseRelayPayload(json);
      if (!msg) return new Response("unrecognized relay payload", { status: 400 });

      const auth = authForRelayMessage(msg);
      if (!auth) return new Response("ignored (bot author)", { status: 200 });
      if (msg.content.trim().length === 0) return new Response("ignored (empty content)", { status: 200 });

      waitUntil(dispatchTurn(msg, auth, send as unknown as DiscordGatewaySend));
      return new Response("ok", { status: 200 });
    }),
  ],
  events: {
    "turn.started": async (_data, channel) => {
      if (statusUxEnabled()) await triggerDiscordTyping(channel.channelId);
    },
    "actions.requested": async (_data, channel) => {
      if (statusUxEnabled() && !peekCardPostedThisTurn()) await triggerDiscordTyping(channel.channelId);
    },
    "action.result": async (_data, channel) => {
      if (statusUxEnabled() && !peekCardPostedThisTurn()) await triggerDiscordTyping(channel.channelId);
    },
    "message.appended": async (_data, channel) => {
      if (statusUxEnabled() && !peekCardPostedThisTurn() && typingRefreshDue(channel.channelId)) await triggerDiscordTyping(channel.channelId);
    },
    "reasoning.appended": async (_data, channel) => {
      if (statusUxEnabled() && !peekCardPostedThisTurn() && typingRefreshDue(channel.channelId)) await triggerDiscordTyping(channel.channelId);
    },
    "turn.failed": async (data, channel) => {
      const detail = (data as { error?: { message?: string } } | undefined)?.error?.message;
      log(`turn failed (channel ${channel.channelId || "?"})${detail ? `: ${detail}` : ""}`);
      await postDiscordReply(
        channel.channelId,
        "⚠️ I hit an error while handling that and couldn't finish. Please try again — and if it keeps failing, check the deployment logs.",
      );
    },
    "message.completed": async (data, channel) => {
      const action = finalMessageAction(data.finishReason, data.message);
      if (action.kind === "buffer-tool-status") return;
      const status = takeTurnStatus(channel.state);
      const plan = planCompletion({
        action,
        reactionActive: Boolean(status.original),
        cardPostedThisTurn: consumeCardPostedThisTurn(),
      });

      if (plan.reaction === "clear" && status.original) {
        await setDiscordReaction(status.original.channelId, status.original.messageId, EYES_EMOJI, "DELETE");
      }

      if (plan.delivery.kind === "post") {
        await postDiscordReply(channel.channelId, action.kind === "post" ? action.text : plan.delivery.chunks.join("\n"));
      } else if (action.kind === "silent" && data.message) {
        log(`judged silence (NO_REPLY) — nothing posted (channel ${channel.channelId || "?"})`);
      }
    },
  },
});
