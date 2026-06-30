import { slackContinuationToken } from "eve/channels/slack";
import { resolvePartition } from "../memory/partition.js";
import { bindFrom, slackMode, type BindableContext } from "../identity/binding.js";
import { isThreadEngaged, markThreadEngaged, shouldDeliverReply, type ReplyDecision } from "./engagement.js";
import { buildSlackAuth, type OpenEverywhereSlackAuth } from "./slack-identity.js";

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

export interface MessageRouteDeps {
  readonly isEngaged: (p: ReturnType<typeof resolvePartition>, threadTs: string) => Promise<boolean>;
  readonly wake: (input: { channelId: string; threadTs: string; auth: unknown; message: string }) => Promise<void>;
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
  await deps.wake({ channelId: ev.channelId, threadTs: ev.threadTs!, auth, message: ev.text });
  if (deps.touch) await deps.touch(p, ev.threadTs!, deps.now ? deps.now() : new Date().toISOString());
  return { ...decision, woke: true };
}

export function liveDeps(send: (input: { message: string; context?: readonly string[] }, opts: { auth: unknown; continuationToken: string }) => Promise<unknown>): MessageRouteDeps {
  return {
    isEngaged: (p, threadTs) => isThreadEngaged(p, threadTs),
    touch: (p, threadTs, atIso) => markThreadEngaged(p, threadTs, atIso),
    async wake({ channelId, threadTs, auth, message }) {
      await send({ message }, { auth, continuationToken: slackContinuationToken(channelId, threadTs) });
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
