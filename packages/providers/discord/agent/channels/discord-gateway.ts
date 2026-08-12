import { defineChannel, POST, type RouteHandlerArgs } from "eve/channels";
import { buildDiscordAuth, type OpenEverywhereDiscordAuth } from "./discord-identity.js";
import { threadParentChannelId } from "./discord-channel-info.js";
import { splitForDiscord } from "./discord-post.js";
import {
  finalMessageAction,
  nameDropPattern,
  NO_REPLY_SENTINEL,
  shouldRotate,
  renderWake,
  mkMessageTrigger,
  supervisorGrainFor,
  unifiedSupervisorToken,
  grainUsesUnifiedWindow,
  mintRotationToken,
  mintWakeId,
  singleWindowMentionPolicy,
  divertToUnifiedWindow,
  verifyWebhookSignature,
  cancelAnchoredTurn,
  turnAnchorKey,
  STOP_HAND_UNICODE,
  STOP_HAND_SLACK_NAME,
  type AttachSessionForCancel,
  domainKeyOf,
  resolvePartition,
  nameDropWakeEnabled,
  engagementTierFor,
  getConfig,
  deploymentOrg,
  isVouchedInternal,
  resolveWakeTrustFromContext,
  getOperationalStore,
  appendAudit,
  type FinalMessageAction,
  type NormalizedWake,
  type WakeEngagementTier,
  type WakeTrust,
  type SupervisorGrain,
  type SingleWindowMentionPolicy,
  type UnifiedWakeOrigin,
  type UnifiedWindowWake,
  type Partition,
  type ContextLine,
  type BindableContext,
} from "@open-everywhere/core/agent/adapter-api.js";

export { splitForDiscord };
import {
  bumpThreadSilentStreak,
  disengageThread,
  getThreadEngagement,
  isStopRequest,
  isThreadEngaged,
  markThreadEngaged,
  WARM_SILENT_LIMIT,
  ingressSpendGate,
  type SpendGateDoor,
  consumeCardPostedThisTurn,
  peekCardPostedThisTurn,
  consumeRepliedThisTurn,
  postTerminalProse,
  isAllowedDriver,
  getOrCreateDmSeat,
  touchDmSeat,
  buildIngestedReaction,
  ingestReaction,
  liveReactionSink,
  type ChatAuditPartition,
  type ReactionSinkDeps,
  type ReactionIngestOutcome,
  type ReactionVerb,
  getSettings,
} from "@open-everywhere/core/agent/adapter-api.js";
import { fetchDiscordBackscroll, fetchDiscordBackscrollLines, distillDiscordRotationHandoff } from "./discord-backscroll.js";

function log(msg: string): void {
  console.log(`[open-everywhere:discord-gateway] ${msg}`);
}

export interface DiscordGatewayState {
  channelId: string;
  guildId?: string;
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
  readonly botName?: string;
  readonly botId?: string;
  readonly memberPending?: boolean;
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
  const bot = isObject(m["bot"]) ? (m["bot"] as Record<string, unknown>) : undefined;
  const member = isObject(m["member"]) ? (m["member"] as Record<string, unknown>) : undefined;
  return {
    id: str(m["id"]) ?? "",
    content: typeof m["content"] === "string" ? (m["content"] as string) : "",
    channelId,
    channelType: strOrNum(m["channelType"]),
    guildId: str(m["guildId"]),
    author: { id: authorId, username: str(author!["username"]), bot: author!["bot"] === true },
    mentionsBot: m["mentionsBot"] === true,
    referencedMessageId: str(m["referencedMessageId"]),
    memberPending: member && typeof member["pending"] === "boolean" ? (member["pending"] as boolean) : undefined,
    botName: bot ? str(bot["name"]) : undefined,
    botId: bot ? str(bot["id"]) : undefined,
  };
}

export interface DiscordRelayReaction {
  readonly verb: ReactionVerb;
  readonly messageId: string;
  readonly channelId: string;
  readonly guildId?: string;
  readonly channelType?: string;
  readonly emoji: string;
  readonly reactorId: string;
  readonly messageAuthorId?: string;
  readonly botId?: string;
}

export function parseRelayReaction(raw: unknown): DiscordRelayReaction | null {
  if (!isObject(raw)) return null;
  if (raw["source"] !== "discord-gateway-relay") return null;
  const ev = raw["event"];
  if (ev !== "MESSAGE_REACTION_ADD" && ev !== "MESSAGE_REACTION_REMOVE") return null;
  const r = raw["reaction"];
  if (!isObject(r)) return null;
  const messageId = str(r["messageId"]);
  const channelId = str(r["channelId"]);
  const reactorId = str(r["reactorId"]);
  const emoji = str(r["emoji"]);
  if (!messageId || !channelId || !reactorId || !emoji) return null;
  return {
    verb: ev === "MESSAGE_REACTION_ADD" ? "added" : "removed",
    messageId,
    channelId,
    guildId: str(r["guildId"]),
    channelType: strOrNum(r["channelType"]),
    emoji,
    reactorId,
    messageAuthorId: str(r["messageAuthorId"]),
    botId: str(r["botId"]),
  };
}

export interface DiscordReactionRouteDeps {
  readonly sink: ReactionSinkDeps;
  readonly attachSession?: AttachSessionForCancel;
}

function isStopHand(emoji: string): boolean {
  const bare = emoji.trim();
  return bare === STOP_HAND_UNICODE || bare === STOP_HAND_SLACK_NAME;
}

async function routeStopHandReaction(rx: DiscordRelayReaction, attachSession: AttachSessionForCancel): Promise<ReactionIngestOutcome> {
  if (!rx.botId) {
    return { recorded: false, onBotReply: false, reason: "stop: bot identity unresolved — refusing to cancel (fail-closed)" };
  }
  if (rx.reactorId === rx.botId) {
    return { recorded: false, onBotReply: false, reason: "stop: the reactor is the bot itself — never a self-cancel" };
  }
  const auth = buildDiscordAuth({ userId: rx.reactorId, guildId: rx.guildId, channelId: rx.channelId, channelType: rx.channelType });
  const p = resolvePartition(ctxFromAuth(auth));
  const result = await cancelAnchoredTurn({
    org: p.org,
    platform: "discord",
    workspace: p.workspace,
    requestedBy: rx.reactorId,
    via: "reaction",
    query: { anchorKey: turnAnchorKey("discord", rx.channelId, rx.messageId)! },
    attachSession,
  });
  return { recorded: false, onBotReply: false, reason: `stop: ${result.outcome}` };
}

export async function routeDiscordReaction(rx: DiscordRelayReaction, deps: DiscordReactionRouteDeps): Promise<ReactionIngestOutcome> {
  if (rx.verb === "added" && isStopHand(rx.emoji) && deps.attachSession) {
    return routeStopHandReaction(rx, deps.attachSession);
  }
  if (rx.botId && rx.reactorId === rx.botId) {
    return { recorded: false, onBotReply: false, reason: "reactor is the bot itself — ignored (not feedback)" };
  }
  const onBotReply = Boolean(rx.botId) && rx.messageAuthorId === rx.botId;
  const auth = buildDiscordAuth({ userId: rx.reactorId, guildId: rx.guildId, channelId: rx.channelId, channelType: rx.channelType });
  const p = resolvePartition(ctxFromAuth(auth));
  const reaction = buildIngestedReaction({
    surface: "discord",
    verb: rx.verb,
    reactorId: rx.reactorId,
    emoji: rx.emoji,
    target: { channelId: rx.channelId, messageId: rx.messageId },
    onBotReply,
    partition: p,
  });
  return ingestReaction(reaction, deps.sink);
}

export function liveDiscordReactionDeps(attachSession?: AttachSessionForCancel): DiscordReactionRouteDeps {
  return { sink: liveReactionSink(), ...(attachSession ? { attachSession } : {}) };
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
  if (msg.author.bot) {
    if (!isAllowedDriver(msg.guildId, msg.author.id)) return null;
    log(`e2e driver accepted as user: bot ${msg.author.id} in guild ${msg.guildId} (OE_TEST_DRIVER_IDS)`);
  }
  return buildDiscordAuth({
    userId: msg.author.id,
    guildId: msg.guildId,
    channelId: msg.channelId,
    channelType: msg.channelType,
    memberPending: msg.memberPending,
  });
}

function ctxFromAuth(auth: OpenEverywhereDiscordAuth): BindableContext {
  return { channel: { kind: "discord" }, session: { auth: { current: auth } } };
}

export function isThreadChannelType(channelType: string | undefined): boolean {
  return channelType === "10" || channelType === "11" || channelType === "12";
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

export function nameDropEligible(input: {
  readonly mentionsBot: boolean;
  readonly isDm: boolean;
  readonly isEngaged: boolean;
  readonly authorIsBot: boolean;
  readonly channelType?: string;
  readonly content: string;
  readonly botName?: string;
}): boolean {
  if (input.mentionsBot || input.isDm || input.isEngaged) return false;
  if (input.authorIsBot) return false;
  const t = input.channelType;
  if (t !== "0" && t !== "5" && t !== "10" && t !== "11" && t !== "12") return false;
  if (!input.botName) return false;
  return nameDropPattern(input.botName).test(input.content);
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
    if (!chunk.trim()) continue;
    await discordCreateMessage(channelId, chunk);
  }
}

const lastTypingAt = new Map<string, number>();
const TYPING_REFRESH_MS = 7_000;

export function clearTypingThrottleForTest(): void {
  lastTypingAt.clear();
}

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

const closedTypingGates = new Set<string>();

export function closeTypingGate(channelId: string, gates: Set<string> = closedTypingGates): void {
  gates.add(channelId);
}

export function openTypingGate(channelId: string, gates: Set<string> = closedTypingGates): void {
  gates.delete(channelId);
}

export function typingGateOpen(channelId: string, gates: Set<string> = closedTypingGates): boolean {
  return !gates.has(channelId);
}

export function typingGateFeed(
  channelId: string,
  messageSoFar: string,
  gates: Set<string> = closedTypingGates,
): boolean {
  if (!gates.has(channelId)) return true;
  const t = messageSoFar.trimStart();
  if (t.startsWith(NO_REPLY_SENTINEL) || NO_REPLY_SENTINEL.startsWith(t)) return false;
  gates.delete(channelId);
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

export function stripLeadingMention(content: string): string {
  return content.replace(/^\s*<@!?[^>]+>\s*/, "");
}

export function shouldAutoThread(channelType: string | undefined, enabled: boolean): boolean {
  if (!enabled) return false;
  return channelType === "0" || channelType === "5";
}

export function autoThreadEnabled(env?: string): boolean {
  return env === undefined ? getSettings().discord.autoThread : env !== "false" && env !== "0";
}

export function statusUxEnabled(env?: string): boolean {
  return env === undefined ? getSettings().discord.statusUx : env !== "false" && env !== "0";
}

export function deriveThreadName(content: string, botName?: string): string {
  const fallback = `Conversation with ${botName ?? "the agent"}`;
  const cleaned = stripLeadingMention(content).replace(/\s+/g, " ").trim();
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
      parentChannelId: msg.channelId,
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
  readonly guildId?: string;
  readonly original?: { readonly channelId: string; readonly messageId: string };
}): DiscordGatewayState {
  return {
    channelId: input.replyChannelId,
    guildId: input.guildId,
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

export type UnifiedReceive = RouteHandlerArgs["to"];

function discordGrainFor(domainKey: string): SupervisorGrain {
  try {
    return supervisorGrainFor(domainKey, getConfig().loadDomains());
  } catch {
    return { unified: false, registryKey: domainKey };
  }
}

function discordEngagementTier(domainKey: string): WakeEngagementTier | undefined {
  try {
    return engagementTierFor(domainKey, getConfig().loadDomains());
  } catch {
    return undefined;
  }
}

export function discordSingleWindowPrivacyOk(
  input: {
    readonly guildId: string | undefined;
    readonly workspaceKey: string;
    readonly surfaceKey: string;
    readonly domainKey?: string;
  },
  deps: { readonly vouched?: (workspaceKey: string, surfaceKey: string) => boolean; readonly trustEnv?: string | undefined } = {},
): boolean {
  if (!input.guildId) return false;
  const vouched = deps.vouched ?? isVouchedInternal;
  const trustEnv = "trustEnv" in deps ? deps.trustEnv : process.env.OE_TRUST;
  if (trustEnv === "internal") return true;
  if (vouched(input.workspaceKey, input.surfaceKey)) return true;
  return input.domainKey !== undefined && input.domainKey !== input.surfaceKey && vouched(input.workspaceKey, input.domainKey);
}

export function discordSingleWindowMentionPolicy(singleWindow: boolean, isMention: boolean, privacyOk: boolean): SingleWindowMentionPolicy {
  return singleWindowMentionPolicy(singleWindow, isMention, privacyOk);
}

export interface DiscordUnifiedWakeInput {
  readonly guildId: string;
  readonly channelId: string;
  readonly parentChannelId?: string;
  readonly isThread: boolean;
  readonly addressing: "direct-mention" | "channel-watch" | "name-drop";
  readonly wakeId: string;
  readonly engagementTier?: WakeEngagementTier;
  readonly handoffNote?: string;
  readonly handoffFromGeneration?: number;
  readonly botName?: string;
  readonly trigger: {
    readonly id: string;
    readonly author: string;
    readonly authorId: string;
    readonly sentAt: string;
    readonly text: string;
    readonly trust?: WakeTrust;
  };
}

export function buildDiscordUnifiedWake(input: DiscordUnifiedWakeInput): NormalizedWake {
  const direct = input.addressing === "direct-mention";
  return {
    platform: "discord",
    reason: direct ? "mention" : "channel-activity",
    addressing: input.addressing,
    engagementTier: input.addressing === "channel-watch" ? input.engagementTier : undefined,
    unifiedDisclosure: true,
    wakeId: input.wakeId,
    locus: {
      channel: { id: input.parentChannelId ?? input.channelId, platform: "discord" },
      ...(input.isThread ? { thread: { ts: input.channelId } } : {}),
    },
    ...(input.addressing === "name-drop" && input.botName
      ? {
          nameDrop: {
            botName: input.botName,
            followUp: input.isThread ? ("thread-engaged" as const) : ("channel-not-following" as const),
          },
        }
      : {}),
    handoff: input.handoffNote ? { note: input.handoffNote, fromGeneration: input.handoffFromGeneration ?? 0 } : undefined,
    trigger: mkMessageTrigger({
      from: "human",
      author: input.trigger.author,
      authorId: input.trigger.authorId,
      id: input.trigger.id,
      sentAt: input.trigger.sentAt,
      trust: input.trigger.trust ?? (direct ? "principal" : "peer"),
      mention: direct ? true : undefined,
      body: input.trigger.text,
    }),
  };
}

export interface DiscordNativeWakeInput {
  readonly channelId: string;
  readonly parentChannelId?: string;
  readonly isThread: boolean;
  readonly isDm: boolean;
  readonly addressing: "direct" | "thread-follow" | "name-drop";
  readonly botName?: string;
  readonly contextLines?: readonly ContextLine[];
  readonly contextSource?: string;
  readonly trigger: {
    readonly id: string;
    readonly author: string;
    readonly authorId: string;
    readonly sentAt: string;
    readonly text: string;
    readonly trust?: WakeTrust;
  };
}

export function discordNativeWake(input: DiscordNativeWakeInput): NormalizedWake {
  const direct = input.addressing === "direct";
  return {
    platform: "discord",
    reason: direct ? (input.isDm ? "dm" : "mention") : input.isThread ? "thread-activity" : "channel-activity",
    addressing: input.addressing,
    locus: {
      channel: { id: input.parentChannelId ?? input.channelId },
      ...(input.isThread ? { thread: { ts: input.channelId } } : {}),
    },
    ...(input.addressing === "name-drop" && input.botName
      ? {
          nameDrop: {
            botName: input.botName,
            followUp: input.isThread ? ("thread-engaged" as const) : ("channel-not-following" as const),
          },
        }
      : {}),
    ...(input.contextLines ? { contextLines: input.contextLines, contextSource: input.contextSource } : {}),
    trigger: mkMessageTrigger({
      from: "human",
      author: input.trigger.author,
      authorId: input.trigger.authorId,
      id: input.trigger.id,
      sentAt: input.trigger.sentAt,
      trust: input.trigger.trust ?? (direct ? "principal" : "peer"),
      mention: undefined,
      body: input.trigger.text,
    }),
  };
}

export interface DiscordDmWakeInput {
  readonly channelId: string;
  readonly wakeId: string;
  readonly handoffNote?: string;
  readonly handoffFromGeneration?: number;
  readonly trigger: {
    readonly id: string;
    readonly author: string;
    readonly authorId: string;
    readonly sentAt: string;
    readonly text: string;
    readonly trust?: WakeTrust;
  };
}

export function buildDiscordDmWake(input: DiscordDmWakeInput): NormalizedWake {
  return {
    platform: "discord",
    reason: "dm",
    addressing: "direct-mention",
    wakeId: input.wakeId,
    locus: { channel: { id: input.channelId } },
    handoff: input.handoffNote ? { note: input.handoffNote, fromGeneration: input.handoffFromGeneration ?? 0 } : undefined,
    trigger: mkMessageTrigger({
      from: "human",
      author: input.trigger.author,
      authorId: input.trigger.authorId,
      id: input.trigger.id,
      sentAt: input.trigger.sentAt,
      trust: input.trigger.trust ?? "principal",
      mention: true,
      body: input.trigger.text,
    }),
  };
}

async function divertDiscordDmToWindow(input: {
  readonly msg: DiscordRelayMessage;
  readonly auth: OpenEverywhereDiscordAuth;
  readonly partition: Partition;
  readonly receive: UnifiedReceive;
}): Promise<void> {
  const { msg } = input;
  const org = deploymentOrg();
  const atIso = new Date().toISOString();
  const surfaceKey = input.partition.surfaceKey;

  const seat = await getOrCreateDmSeat(org, { surfaceKey }, atIso, {
    distillHandoff: (scope, outgoing) => distillDiscordRotationHandoff(scope, msg.channelId, outgoing, org, msg.botId),
  });

  const trust = resolveWakeTrustFromContext(ctxFromAuth(input.auth), { id: msg.author.id, isBot: msg.author.bot }, { principalFallback: true });
  const wakeId = mintWakeId();

  const origin: UnifiedWakeOrigin = { platform: "discord", channelId: msg.channelId, dm: true };

  const rendered = renderWake(
    buildDiscordDmWake({
      channelId: msg.channelId,
      wakeId,
      ...(seat.freshGeneration && seat.handoffNote ? { handoffNote: seat.handoffNote, handoffFromGeneration: Math.max(seat.generation - 1, 0) } : {}),
      trigger: {
        id: msg.id || "unknown",
        author: msg.author.username ?? msg.author.id,
        authorId: msg.author.id,
        sentAt: atIso,
        text: msg.content,
        trust,
      },
    }),
  );
  await divertToUnifiedWindow(input.receive, {
    message: rendered.message,
    ...(rendered.context && rendered.context.length > 0 ? { context: rendered.context } : {}),
    token: seat.token,
    window: { wakeId, origin, addressing: "direct-mention" } satisfies UnifiedWindowWake,
    surfaceKey,
    auth: input.auth as unknown as { attributes?: Record<string, unknown> },
  });
  await touchDmSeat(org, surfaceKey, atIso).catch(() => undefined);
}

async function divertDiscordWakeToUnifiedWindow(input: {
  readonly msg: DiscordRelayMessage;
  readonly auth: OpenEverywhereDiscordAuth;
  readonly partition: Partition;
  readonly grain: SupervisorGrain;
  readonly addressing: "direct-mention" | "channel-watch" | "name-drop";
  readonly receive: UnifiedReceive;
  readonly context: readonly string[];
}): Promise<void> {
  const { msg, grain } = input;
  const org = deploymentOrg();
  const store = getOperationalStore();
  const atIso = new Date().toISOString();

  if (input.addressing === "direct-mention" && isThreadChannelType(msg.channelType)) {
    await markThreadEngaged(input.partition, msg.channelId, atIso, { participating: true });
  }
  const domainName = grain.domainName ?? "unknown";
  const tokenFor = (gen: number) => mintRotationToken(grain, gen, () => unifiedSupervisorToken(domainName, gen));

  const existing = await store.getChannelSession(org, grain.registryKey);
  let session: { token: string; generation: number; fresh: boolean; handoffNote?: string | null };
  if (!existing) {
    const row = await store.rotateChannelSession(org, grain.registryKey, tokenFor(1), atIso);
    session = { token: row.token, generation: row.generation, fresh: true, handoffNote: row.handoffNote };
  } else if (shouldRotate(existing, atIso)) {
    const row = await store.rotateChannelSession(org, grain.registryKey, tokenFor(existing.generation + 1), atIso);
    session = { token: row.token, generation: row.generation, fresh: true, handoffNote: row.handoffNote };
  } else {
    session = { token: existing.token, generation: existing.generation, fresh: existing.firstWakeAt == null, handoffNote: existing.handoffNote };
  }

  const trust = resolveWakeTrustFromContext(ctxFromAuth(input.auth), { id: msg.author.id, isBot: msg.author.bot }, { principalFallback: true });

  const doWake = async (token: string, generation: number, handoffNote: string | null | undefined): Promise<void> => {
    const wakeId = mintWakeId();
    const origin: UnifiedWakeOrigin = {
      platform: "discord",
      channelId: msg.channelId,
      guildId: msg.guildId ?? "",
      ...(msg.id ? { messageId: msg.id } : {}),
      ...(msg.id && input.addressing === "direct-mention" && shouldAutoThread(msg.channelType, autoThreadEnabled())
        ? { autoThreadName: deriveThreadName(msg.content) }
        : {}),
    };
    const rendered = renderWake(
      buildDiscordUnifiedWake({
        guildId: msg.guildId ?? "",
        channelId: msg.channelId,
        parentChannelId: str(input.auth.attributes.parent_channel_id),
        isThread: isThreadChannelType(msg.channelType),
        addressing: input.addressing,
        wakeId,
        engagementTier: discordEngagementTier(domainKeyOf(input.partition)),
        handoffNote: handoffNote ?? undefined,
        handoffFromGeneration: generation - 1,
        botName: msg.botName,
        trigger: {
          id: msg.id || "unknown",
          author: msg.author.username ?? msg.author.id,
          authorId: msg.author.id,
          sentAt: atIso,
          text: msg.content,
          trust,
        },
      }),
    );
    await divertToUnifiedWindow(input.receive, {
      message: rendered.message,
      context: [...(rendered.context ?? []), ...input.context],
      token,
      window: {
        wakeId,
        origin,
        ...(input.addressing === "direct-mention" ? { addressing: "direct-mention" as const } : {}),
      } satisfies UnifiedWindowWake,
      surfaceKey: domainKeyOf(input.partition),
      auth: input.auth as unknown as { attributes?: Record<string, unknown> },
    });
  };

  await doWake(session.token, session.generation, session.fresh ? session.handoffNote : undefined);
  await store.touchChannelSession(org, grain.registryKey, atIso).catch(() => undefined);
}

export type DiscordGatewaySend = (
  message: string | { readonly message: string; readonly context?: readonly string[] },
  options: {
    auth: OpenEverywhereDiscordAuth;
    continuationToken: string;
    state: DiscordGatewayState;
  },
) => Promise<unknown>;

export async function dispatchTurn(
  msg: DiscordRelayMessage,
  auth: OpenEverywhereDiscordAuth,
  send: DiscordGatewaySend,
  createThread: (channelId: string, messageId: string, name: string) => Promise<string | null> = createDiscordThread,
  resolveParent: (channelId: string) => Promise<string | undefined> = threadParentChannelId,
  receive?: UnifiedReceive,
): Promise<void> {
  if (isThreadChannelType(msg.channelType)) {
    const parentChannelId = await resolveParent(msg.channelId);
    if (parentChannelId) {
      auth = buildDiscordAuth({
        userId: msg.author.id,
        guildId: msg.guildId,
        channelId: msg.channelId,
        channelType: msg.channelType,
        parentChannelId,
      });
    }
  }
  const partition: Partition = resolvePartition(ctxFromAuth(auth));
  const key = engagementKey(msg);
  const isDm = isDmChannel(msg.channelType);
  const engaged = isDm || msg.mentionsBot ? true : await isThreadEngaged(partition, key);

  if (!isDm && (engaged || msg.mentionsBot) && isStopRequest(stripLeadingMention(msg.content))) {
    await disengageThread(partition, key);
    await discordCreateMessage(msg.channelId, "👍 Stopped following here — @mention me (or say my name) when you need me again.");
    log(`disengaged ${partition.surfaceKey} on stop request`);
    return;
  }

  let nameDrop = false;
  if (!shouldDispatchDiscord({ mentionsBot: msg.mentionsBot, isEngaged: engaged, isDm })) {
    nameDrop =
      nameDropEligible({
        mentionsBot: msg.mentionsBot,
        isDm,
        isEngaged: engaged,
        authorIsBot: msg.author.bot && !isAllowedDriver(msg.guildId, msg.author.id),
        channelType: msg.channelType,
        content: msg.content,
        botName: msg.botName,
      }) && nameDropWakeEnabled(domainKeyOf(partition), getConfig().loadDomains());
    if (!nameDrop) {
      log(`drop ${partition.surfaceKey}: non-mention in a channel the agent isn't following`);
      return;
    }
    if (isThreadChannelType(msg.channelType)) {
      await markThreadEngaged(partition, key, new Date().toISOString());
    }
    log(`name-drop wake on ${partition.surfaceKey} ("${msg.botName}")`);
  }

  const spendDoor: SpendGateDoor = msg.mentionsBot || isDm ? "mention" : "engagement";
  if (
    (await ingressSpendGate({
      bindable: ctxFromAuth(auth),
      door: spendDoor,
      principalId: msg.author.id,
      post: async (text) => {
        await discordCreateMessage(msg.channelId, text);
      },
    })) === "declined"
  ) {
    return;
  }

  if (isDm && receive) {
    if (statusUxEnabled()) await setDiscordReaction(msg.channelId, msg.id, EYES_EMOJI, "PUT");
    await divertDiscordDmToWindow({ msg, auth, partition, receive });
    await appendAudit({
      org: deploymentOrg(),
      platform: "discord",
      workspace: partition.workspace,
      surface: partition.surfaceKey,
      principalId: msg.author.id,
      action: "discord.dispatched",
      detail: { addressing: "direct-mention", dmWindow: true, channelId: msg.channelId },
    }).catch(() => undefined);
    log(`dm-window divert ${partition.surfaceKey}`);
    return;
  }

  const windowGrain = discordGrainFor(domainKeyOf(partition));
  if (grainUsesUnifiedWindow(windowGrain) && windowGrain.domainName !== undefined && receive) {
    const privacyOk = discordSingleWindowPrivacyOk({
      guildId: msg.guildId,
      workspaceKey: partition.workspaceKey,
      surfaceKey: partition.surfaceKey,
      domainKey: domainKeyOf(partition),
    });
    const mentionPolicy = discordSingleWindowMentionPolicy(true, msg.mentionsBot, privacyOk);
    if (privacyOk) {
      if (msg.mentionsBot) {
        await markThreadEngaged(partition, key, new Date().toISOString(), { participating: true });
      }
      const windowContext =
        nameDrop || msg.mentionsBot
          ? await fetchDiscordBackscroll({
              channelId: msg.channelId,
              triggerMessageId: msg.id,
              isThread: isThreadChannelType(msg.channelType),
              botId: msg.botId,
            }).catch(() => [])
          : [];
      const addressing = mentionPolicy.addressing ?? (nameDrop && msg.botName ? "name-drop" : "channel-watch");
      await divertDiscordWakeToUnifiedWindow({
        msg,
        auth,
        partition,
        grain: windowGrain,
        addressing,
        receive,
        context: windowContext,
      });
      await appendAudit({
        org: deploymentOrg(),
        platform: "discord",
        workspace: msg.guildId ?? "unknown",
        surface: partition.surfaceKey,
        principalId: msg.author.id,
        action: "discord.dispatched",
        detail: { addressing, singleWindow: true, channelId: msg.channelId },
      }).catch(() => undefined);
      log(`single-window divert ${partition.surfaceKey} (${addressing})`);
      return;
    }
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
    await markThreadEngaged(dispatchPartition, surface.engagementKey, new Date().toISOString(), { participating: true });
  }
  const turnState: DiscordGatewayState = buildGatewayState({
    replyChannelId: surface.state.channelId,
    guildId: msg.guildId,
    original: statusUx && threadId ? { channelId: msg.channelId, messageId: msg.id } : undefined,
  });

  if (statusUx) {
    if (msg.mentionsBot || isDm) {
      openTypingGate(surface.state.channelId);
      await triggerDiscordTyping(surface.state.channelId);
    } else {
      closeTypingGate(surface.state.channelId);
    }
  }

  const isThread = isThreadChannelType(msg.channelType);
  const addressing: "direct" | "thread-follow" | "name-drop" =
    nameDrop && msg.botName ? "name-drop" : msg.mentionsBot || isDm ? "direct" : "thread-follow";

  const trust = resolveWakeTrustFromContext(
    ctxFromAuth(surface.auth),
    { id: msg.author.id, isBot: msg.author.bot },
    { principalFallback: addressing === "direct" },
  );

  const backscroll =
    !isDm && (nameDrop || msg.mentionsBot)
      ? await fetchDiscordBackscrollLines({
          channelId: msg.channelId,
          triggerMessageId: msg.id,
          isThread,
          botId: msg.botId,
        }).catch(() => undefined)
      : undefined;

  const rendered = renderWake(
    discordNativeWake({
      channelId: msg.channelId,
      parentChannelId: str(surface.auth.attributes.parent_channel_id),
      isThread,
      isDm,
      addressing,
      botName: msg.botName,
      contextLines: backscroll?.lines,
      contextSource: backscroll?.source,
      trigger: {
        id: msg.id || "unknown",
        author: msg.author.username ?? msg.author.id,
        authorId: msg.author.id,
        sentAt: new Date().toISOString(),
        text: msg.content,
        trust,
      },
    }),
  );

  await send(
    rendered.context && rendered.context.length ? { message: rendered.message, context: rendered.context } : rendered.message,
    {
      auth: surface.auth,
      continuationToken: surface.continuationToken,
      state: turnState,
    },
  );
  log(
    `dispatched ${dispatchPartition.surfaceKey} (${isDm ? "dm" : msg.mentionsBot ? "mention" : nameDrop ? "name-drop" : "engaged"}` +
      `${threadId ? ", auto-threaded+👀" : ""})`,
  );
}

export function engagementCoordsFor(state: DiscordGatewayState): { p: Partition; key: string } | null {
  if (!state.guildId || !state.channelId) return null;
  const p = resolvePartition(ctxFromAuth(buildDiscordAuth({ userId: "", guildId: state.guildId, channelId: state.channelId })));
  return { p, key: state.channelId };
}

function auditPartitionForGatewayState(state: DiscordGatewayState): ChatAuditPartition | null {
  if (!state.channelId) return null;
  try {
    return resolvePartition(ctxFromAuth(buildDiscordAuth({ userId: "", guildId: state.guildId, channelId: state.channelId })));
  } catch {
    return null;
  }
}

export async function promoteParticipatingOnReply(state: DiscordGatewayState): Promise<void> {
  try {
    const coords = engagementCoordsFor(state);
    if (!coords) return;
    const rec = await getThreadEngagement(coords.p, coords.key);
    if (!rec) return;
    await markThreadEngaged(coords.p, coords.key, new Date().toISOString(), { participating: true });
  } catch (err) {
    console.warn(`[open-everywhere:discord-gateway] participating-promote failed: ${String(err)}`);
  }
}

export async function maybeShedWarmSurface(state: DiscordGatewayState): Promise<void> {
  try {
    const coords = engagementCoordsFor(state);
    if (!coords) return;
    const rec = await getThreadEngagement(coords.p, coords.key);
    if (rec && rec.participating !== true) {
      const streak = await bumpThreadSilentStreak(coords.p, coords.key);
      if (streak >= WARM_SILENT_LIMIT) {
        await disengageThread(coords.p, coords.key);
        log(`warm surface shed after ${streak} silent turns — disengaged (${coords.p.surfaceKey})`);
      }
    }
  } catch (err) {
    console.warn(`[open-everywhere:discord-gateway] warm silent-streak bookkeeping failed: ${String(err)}`);
  }
}

export default defineChannel<DiscordGatewayState, DiscordGatewayContext>({
  kindHint: "discord",
  state: { channelId: "" },
  context: (state: DiscordGatewayState): DiscordGatewayContext => ({
    channelId: state.channelId,
    state,
  }),
  routes: [
    POST<DiscordGatewayState>("/eve/v1/discord-gateway", async (req, { from, waitUntil, to, attachSession }) => {
      const gatewaySend: DiscordGatewaySend = (message, options) => {
        const payload = typeof message === "string" ? { message, context: undefined } : message;
        return from(options.continuationToken).send(payload.message, {
          auth: options.auth,
          state: options.state,
          ...(payload.context && payload.context.length > 0 ? { context: payload.context } : {}),
        } as never);
      };
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
      const reaction = parseRelayReaction(json);
      if (reaction) {
        waitUntil(
          routeDiscordReaction(reaction, liveDiscordReactionDeps(attachSession)).then((o) =>
            log(`reaction ${reaction.channelId}/${reaction.messageId}: ${o.recorded ? "recorded" : "not recorded"} — ${o.reason}`),
          ),
        );
        return new Response("ok", { status: 200 });
      }

      const msg = parseRelayPayload(json);
      if (!msg) return new Response("unrecognized relay payload", { status: 400 });

      const auth = authForRelayMessage(msg);
      if (!auth) return new Response("ignored (bot author)", { status: 200 });
      if (msg.content.trim().length === 0) return new Response("ignored (empty content)", { status: 200 });

      waitUntil(
        dispatchTurn(msg, auth, gatewaySend, undefined, undefined, to).catch((err) =>
          log(`dispatch failed: ${String(err)}`),
        ),
      );
      return new Response("ok", { status: 200 });
    }),
  ],
  events: {
    "turn.started": async (_data, channel) => {
      if (statusUxEnabled() && typingGateOpen(channel.channelId)) await triggerDiscordTyping(channel.channelId);
    },
    "actions.requested": async (_data, channel) => {
      if (statusUxEnabled() && typingGateOpen(channel.channelId) && !peekCardPostedThisTurn()) await triggerDiscordTyping(channel.channelId);
    },
    "action.result": async (_data, channel) => {
      if (statusUxEnabled() && typingGateOpen(channel.channelId) && !peekCardPostedThisTurn()) await triggerDiscordTyping(channel.channelId);
    },
    "message.appended": async (data, channel) => {
      if (!statusUxEnabled()) return;
      const soFar = (data as { messageSoFar?: string } | undefined)?.messageSoFar ?? "";
      if (!typingGateFeed(channel.channelId, soFar)) return;
      if (!peekCardPostedThisTurn() && typingRefreshDue(channel.channelId)) await triggerDiscordTyping(channel.channelId);
    },
    "reasoning.appended": async (_data, channel) => {
      if (statusUxEnabled() && typingGateOpen(channel.channelId) && !peekCardPostedThisTurn() && typingRefreshDue(channel.channelId)) await triggerDiscordTyping(channel.channelId);
    },
    "turn.failed": async (data, channel) => {
      openTypingGate(channel.channelId);
      const detail = (data as { error?: { message?: string } } | undefined)?.error?.message;
      log(`turn failed (channel ${channel.channelId || "?"})${detail ? `: ${detail}` : ""}`);
      await postDiscordReply(
        channel.channelId,
        "⚠️ I hit an error while handling that and couldn't finish. Please try again — and if it keeps failing, check the deployment logs.",
      );
    },
    "message.completed": async (data, channel, ctx) => {
      const sessionId = ctx?.session?.id;
      const action = finalMessageAction(data.finishReason, data.message);
      if (action.kind === "buffer-tool-status") return;
      openTypingGate(channel.channelId);
      const status = takeTurnStatus(channel.state);
      const repliedThisTurn = consumeRepliedThisTurn();
      const cardPostedThisTurn = consumeCardPostedThisTurn();
      const plan = planCompletion({
        action,
        reactionActive: Boolean(status.original),
        cardPostedThisTurn,
      });

      if (plan.reaction === "clear" && status.original) {
        await setDiscordReaction(status.original.channelId, status.original.messageId, EYES_EMOJI, "DELETE");
      }

      const auditP = channel.state.channelId
        ? auditPartitionForGatewayState(channel.state)
        : null;
      if (plan.delivery.kind === "post") {
        const text = action.kind === "post" ? action.text : plan.delivery.chunks.join("\n");
        if (auditP && channel.channelId) {
          await postTerminalProse(
            { platform: "discord", channelId: channel.channelId },
            text,
            { org: auditP.org, platform: auditP.platform, workspace: auditP.workspace, surface: auditP.surface, ...(sessionId ? { sessionId } : {}), route: "terminal" },
          );
        } else {
          await postDiscordReply(channel.channelId, text);
        }
      } else if (action.kind === "silent") {
        if (data.message) log(`judged silence (NO_REPLY) — nothing posted (channel ${channel.channelId || "?"})`);
      }

      if (action.kind === "post") {
        await promoteParticipatingOnReply(channel.state);
      } else if (action.kind === "silent") {
        await maybeShedWarmSurface(channel.state);
      }
    },
  },
});
