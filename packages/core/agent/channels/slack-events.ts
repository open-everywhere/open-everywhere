import { slackContinuationToken } from "eve/channels/slack";
import { resolvePartition } from "../memory/partition.js";
import { bindFrom, slackMode, type BindableContext } from "../identity/binding.js";
import { getConfig } from "../access/config.js";
import { nameDropWakeEnabled } from "../memory/domain.js";
import { isThreadEngaged, markThreadEngaged, shouldDeliverReply, type ReplyDecision } from "./engagement.js";
import { buildSlackAuth, channelFactsFromInfo, type OpenEverywhereSlackAuth } from "./slack-identity.js";

export interface SlackEventEnvelope {
  readonly type?: string;
  readonly team_id?: string;
  readonly event?: Record<string, unknown> & { readonly type?: string };
  readonly [key: string]: unknown;
}

export interface ParsedMessageEvent {
  readonly channelId: string;
  readonly ts: string;
  readonly threadTs?: string;
  readonly teamId?: string;
  readonly userId?: string;
  readonly botId?: string;
  readonly subtype?: string;
  readonly channelType?: string;
  readonly text: string;
  readonly isAppMention: boolean;
}

export function parseMessageEvent(envelope: SlackEventEnvelope): ParsedMessageEvent | null {
  if (envelope?.type !== "event_callback") return null;
  const e = envelope.event as (Record<string, unknown> & { type?: string }) | undefined;
  if (!e) return null;
  if (e.type !== "message" && e.type !== "app_mention") return null;
  const channelId = typeof e.channel === "string" ? e.channel : "";
  const ts = typeof e.ts === "string" ? e.ts : "";
  if (!channelId || !ts) return null;
  const threadTs = typeof e.thread_ts === "string" ? e.thread_ts : undefined;
  const text = typeof e.text === "string" ? e.text : "";
  return {
    channelId,
    ts,
    threadTs,
    teamId: envelope.team_id ?? (typeof e.team === "string" ? e.team : undefined),
    userId: typeof e.user === "string" ? e.user : undefined,
    botId: typeof e.bot_id === "string" ? e.bot_id : undefined,
    subtype: typeof e.subtype === "string" ? e.subtype : undefined,
    channelType: typeof e.channel_type === "string" ? e.channel_type : undefined,
    text,
    isAppMention: e.type === "app_mention",
  };
}

export const NO_REPLY_SENTINEL = "NO_REPLY";

export function isNoReply(message: string): boolean {
  return message.trimStart().startsWith(NO_REPLY_SENTINEL);
}

export function renderWakeMessage(ev: ParsedMessageEvent): string {
  return [
    `[thread-follow] You were not mentioned — this reply reached you because you follow this thread. ` +
      `Reply only if it warrants a response from you: it's addressed to you, asks you something, or moves ` +
      `the task you're working on. If the humans are talking among themselves and your reply would be ` +
      `noise, output exactly ${NO_REPLY_SENTINEL} and nothing else — nothing will be posted. Judge THIS ` +
      `message on its own merits: a run of ${NO_REPLY_SENTINEL} turns above means the earlier messages ` +
      `weren't for you, not that this one isn't.`,
    "",
    ev.text,
  ].join("\n");
}

export type FinalMessageAction =
  | { readonly kind: "buffer-tool-status" }
  | { readonly kind: "silent"; readonly reason: string }
  | { readonly kind: "post"; readonly text: string };

export function finalMessageAction(finishReason: string, message: string | null): FinalMessageAction {
  if (finishReason === "tool-calls") return { kind: "buffer-tool-status" };
  if (!message) return { kind: "silent", reason: "empty final message" };
  if (isNoReply(message)) return { kind: "silent", reason: "NO_REPLY sentinel — judged not warranted" };
  return { kind: "post", text: message };
}

export interface MessageRouteDeps {
  readonly isEngaged: (p: ReturnType<typeof resolvePartition>, threadTs: string) => Promise<boolean>;
  readonly wake: (input: { channelId: string; threadTs: string; auth: unknown; message: string; state?: unknown }) => Promise<void>;
  readonly touch?: (p: ReturnType<typeof resolvePartition>, threadTs: string, atIso: string) => Promise<void>;
  readonly now?: () => string;
}

export interface RouteOutcome extends ReplyDecision {
  readonly woke: boolean;
}

function bindableFor(ev: ParsedMessageEvent): BindableContext {
  return {
    channel: { kind: "slack" },
    session: {
      auth: {
        current: {
          attributes: {
            team_id: ev.teamId ?? "",
            channel_id: ev.channelId,
            channel_type: ev.channelType ?? "",
          },
          principalId: ev.userId ?? "",
          principalType: "slack-user",
        },
      },
    },
  } as BindableContext;
}

export async function routeMessageEvent(ev: ParsedMessageEvent, deps: MessageRouteDeps): Promise<RouteOutcome> {
  const inThread = Boolean(ev.threadTs);
  const pre = shouldDeliverReply({
    isEngaged: true,
    authorIsBot: Boolean(ev.botId),
    isAppMention: ev.isAppMention,
    inThread,
    subtype: ev.subtype,
  });
  if (!pre.deliver) return { ...pre, woke: false };

  const p = resolvePartition(bindableFor(ev));
  const engaged = await deps.isEngaged(p, ev.threadTs!);
  const decision = shouldDeliverReply({
    isEngaged: engaged,
    authorIsBot: Boolean(ev.botId),
    isAppMention: ev.isAppMention,
    inThread,
    subtype: ev.subtype,
  });
  if (!decision.deliver) return { ...decision, woke: false };

  const auth = authForEvent(ev);
  await deps.wake({
    channelId: ev.channelId,
    threadTs: ev.threadTs!,
    auth,
    message: renderWakeMessage(ev),
    state: wakeState(ev, ev.threadTs!),
  });
  if (deps.touch) await deps.touch(p, ev.threadTs!, deps.now ? deps.now() : new Date().toISOString());
  return { ...decision, woke: true };
}

export type WakeSend = (
  input: { message: string; context?: readonly string[] },
  opts: { auth: unknown; continuationToken: string; state?: unknown },
) => Promise<unknown>;

function wakeState(ev: ParsedMessageEvent, threadTs: string): unknown {
  return {
    channelId: ev.channelId,
    threadTs,
    teamId: ev.teamId ?? null,
    triggeringUserId: ev.userId ?? null,
  };
}

export function liveDeps(send: WakeSend): MessageRouteDeps {
  return {
    isEngaged: (p, threadTs) => isThreadEngaged(p, threadTs),
    touch: (p, threadTs, atIso) => markThreadEngaged(p, threadTs, atIso),
    async wake({ channelId, threadTs, auth, message, state }) {
      await send({ message }, { auth, continuationToken: slackContinuationToken(channelId, threadTs), state });
    },
  };
}

function authForEvent(ev: ParsedMessageEvent): OpenEverywhereSlackAuth {
  return buildSlackAuth({
    userId: ev.userId ?? "",
    teamId: ev.teamId,
    channelId: ev.channelId,
    threadTs: ev.threadTs,
    channelType: ev.channelType,
  });
}

export const _engagementWakeMode = (ev: ParsedMessageEvent) => slackMode(ev.channelType, ev.channelId);

export function nameDropPattern(name: string): RegExp {
  const escaped = name
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+");
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, "iu");
}

export interface NameDropInput {
  readonly inThread: boolean;
  readonly authorIsBot: boolean;
  readonly isAppMention: boolean;
  readonly subtype?: string;
  readonly channelType?: string;
  readonly textMatchesName: boolean;
  readonly domainEnabled: boolean;
  readonly channelConfirmedInternal: boolean;
}

export function shouldNameDropWake(input: NameDropInput): ReplyDecision {
  if (input.inThread) return { deliver: false, reason: "thread reply — the engagement path owns threads" };
  if (input.subtype) return { deliver: false, reason: `message subtype "${input.subtype}" — not a plain message` };
  if (input.authorIsBot) return { deliver: false, reason: "author is a bot — would self-trigger" };
  if (input.isAppMention) return { deliver: false, reason: "app_mention — the mention path owns it" };
  if (input.channelType !== "channel" && input.channelType !== "group") {
    return { deliver: false, reason: `channel_type "${String(input.channelType)}" — name-drop is channels/groups only` };
  }
  if (!input.textMatchesName) return { deliver: false, reason: "text does not say the agent's name" };
  if (!input.domainEnabled) return { deliver: false, reason: "nameDropWake not enabled for this channel's domain" };
  if (!input.channelConfirmedInternal) {
    return { deliver: false, reason: "channel not confirmed internal — fail closed (externally shared or unverifiable)" };
  }
  return { deliver: true, reason: "name-dropped in an enabled internal channel — judged wake" };
}

export function renderNameDropMessage(ev: ParsedMessageEvent, name: string): string {
  return [
    `[name-drop] A top-level channel message said your name ("${name}") without @mentioning you. ` +
      `You were NOT invited into this conversation — reply only if the message is clearly asking for ` +
      `you or requesting something you can directly do. When in doubt, stay out: output exactly ` +
      `${NO_REPLY_SENTINEL} and nothing else — nothing will be posted. If you do reply, you will be ` +
      `following the thread from then on, so make it count.`,
    "",
    ev.text,
  ].join("\n");
}

export interface NameDropRouteDeps {
  readonly enabledFor: (surfaceKey: string) => boolean;
  readonly confirmInternal: (channelId: string) => Promise<boolean>;
  readonly wake: (input: { channelId: string; threadTs: string; auth: unknown; message: string; state?: unknown }) => Promise<void>;
  readonly displayName: () => Promise<string | undefined>;
}

export async function routeNameDropEvent(ev: ParsedMessageEvent, deps: NameDropRouteDeps): Promise<RouteOutcome> {
  const name = (await deps.displayName())?.trim();
  const matched = name && nameDropPattern(name).test(ev.text) ? name : undefined;
  const base = {
    inThread: Boolean(ev.threadTs),
    authorIsBot: Boolean(ev.botId),
    isAppMention: ev.isAppMention,
    subtype: ev.subtype,
    channelType: ev.channelType,
    textMatchesName: matched !== undefined,
  };
  const pre = shouldNameDropWake({ ...base, domainEnabled: true, channelConfirmedInternal: true });
  if (!pre.deliver) return { ...pre, woke: false };

  const p = resolvePartition(bindableFor(ev));
  const enabled = deps.enabledFor(p.surfaceKey);
  if (!enabled) return { ...shouldNameDropWake({ ...base, domainEnabled: false, channelConfirmedInternal: true }), woke: false };

  const internal = await deps.confirmInternal(ev.channelId);
  const decision = shouldNameDropWake({ ...base, domainEnabled: true, channelConfirmedInternal: internal });
  if (!decision.deliver) return { ...decision, woke: false };

  await deps.wake({
    channelId: ev.channelId,
    threadTs: ev.ts,
    auth: authForEvent({ ...ev, threadTs: ev.ts }),
    message: renderNameDropMessage(ev, matched!),
    state: wakeState(ev, ev.ts),
  });
  return { ...decision, woke: true };
}

let botDisplayNamePromise: Promise<string | undefined> | undefined;

export function botDisplayName(): Promise<string | undefined> {
  if (!botDisplayNamePromise) {
    botDisplayNamePromise = (async () => {
      const token = process.env.SLACK_BOT_TOKEN;
      if (!token) return undefined;
      const call = async (method: string, body: string) => {
        const res = await fetch(`https://slack.com/api/${method}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded" },
          body,
        });
        return (await res.json()) as Record<string, unknown>;
      };
      try {
        const auth = await call("auth.test", "");
        const userId = auth.ok === true && typeof auth.user_id === "string" ? auth.user_id : undefined;
        if (!userId) return undefined;
        const info = await call("users.info", `user=${encodeURIComponent(userId)}`);
        if (info.ok !== true) return undefined;
        const user = info.user as { profile?: { display_name?: string; real_name?: string }; real_name?: string; name?: string } | undefined;
        const name = user?.profile?.display_name?.trim() || user?.profile?.real_name?.trim() || user?.real_name?.trim() || user?.name?.trim();
        return name || undefined;
      } catch {
        return undefined;
      }
    })();
  }
  return botDisplayNamePromise;
}

export function _resetBotDisplayName(): void {
  botDisplayNamePromise = undefined;
}

const CHANNEL_TRUST_TTL = Number(process.env.OE_DM_TRUST_TTL_MS) || 5 * 60_000;
const channelTrustCache = new Map<string, { internal: boolean; at: number }>();

async function confirmChannelInternal(channelId: string): Promise<boolean> {
  const hit = channelTrustCache.get(channelId);
  if (hit && Date.now() - hit.at < CHANNEL_TRUST_TTL) return hit.internal;
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return false;
  try {
    const res = await fetch("https://slack.com/api/conversations.info", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded" },
      body: `channel=${encodeURIComponent(channelId)}`,
    });
    const facts = channelFactsFromInfo(await res.json());
    const internal = facts.trustChecked === true && facts.isExternal === false;
    channelTrustCache.set(channelId, { internal, at: Date.now() });
    return internal;
  } catch {
    return false;
  }
}

export function liveNameDropDeps(send: WakeSend): NameDropRouteDeps {
  return {
    enabledFor: (surfaceKey) => nameDropWakeEnabled(surfaceKey, getConfig().loadDomains()),
    confirmInternal: confirmChannelInternal,
    displayName: botDisplayName,
    async wake({ channelId, threadTs, auth, message, state }) {
      await send({ message }, { auth, continuationToken: slackContinuationToken(channelId, threadTs), state });
    },
  };
}
