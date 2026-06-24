import {
  slackChannel,
  type SlackContext,
  type SlackEventContext,
  type SlackHandle,
  type SlackMessage,
} from "eve/channels/slack";
import {
  buildSlackAuth,
  channelFactsFromInfo,
  channelFactsFromRaw,
  type ChannelFacts,
  type OpenEverywhereSlackAuth,
} from "./slack-identity.js";
import { resolvePartition } from "../memory/partition.js";
import { readTier, SURFACE } from "../memory/store.js";
import {
  STATUS_REACTION,
  renderPinned,
  PINNED_HEADER,
  type WorkState,
} from "../status/status.js";

async function setStatusReaction(slack: SlackHandle, state: WorkState): Promise<void> {
  const channel = slack.channelId;
  const timestamp = slack.threadTs;
  if (!channel || !timestamp) return;
  for (const [s, name] of Object.entries(STATUS_REACTION)) {
    try {
      await slack.request(s === state ? "reactions.add" : "reactions.remove", { channel, name, timestamp });
    } catch {
    }
  }
}
async function syncPinnedStatus(channel: SlackEventContext): Promise<void> {
  try {
    const { channelId, teamId } = channel.state;
    if (!channelId) return;
    const p = resolvePartition({
      channel: { kind: "slack" },
      session: { auth: { current: { attributes: { team_id: teamId ?? "", channel_id: channelId }, principalId: "", principalType: "slack-user" } } },
    });
    const files = await readTier(p, SURFACE);
    const text = renderPinned(files["STATUS.md"]);

    const slack = channel.slack;
    const list = await slack.request("pins.list", { channel: channelId });
    let ts: string | undefined;
    const items = (list as { items?: unknown }).items;
    if (list.ok && Array.isArray(items)) {
      for (const it of items) {
        const m = (it as { message?: { text?: unknown; ts?: unknown } })?.message;
        if (m && typeof m.text === "string" && m.text.startsWith(PINNED_HEADER) && typeof m.ts === "string") {
          ts = m.ts;
          break;
        }
      }
    }
    if (ts) {
      await slack.request("chat.update", { channel: channelId, ts, text });
    } else {
      const posted = await slack.request("chat.postMessage", { channel: channelId, text });
      const postedTs = (posted as { ts?: unknown }).ts;
      if (posted.ok && typeof postedTs === "string") {
        await slack.request("pins.add", { channel: channelId, timestamp: postedTs });
      }
    }
  } catch {
  }
}

async function enrichVisibility(ctx: SlackContext, channelId: string, base: ChannelFacts): Promise<ChannelFacts> {
  if (base.isPrivate !== undefined) return base;
  try {
    const info = await ctx.slack.request("conversations.info", { channel: channelId });
    return { ...base, ...channelFactsFromInfo(info) };
  } catch {
    return base;
  }
}

async function deriveAuth(ctx: SlackContext, message: SlackMessage, isDm: boolean): Promise<OpenEverywhereSlackAuth | null> {
  const author = message.author;
  if (!author) return null;

  const facts: ChannelFacts = isDm
    ? { channelType: "im", isPrivate: true }
    : await enrichVisibility(ctx, message.channelId, channelFactsFromRaw(message.raw));

  return buildSlackAuth({
    userId: author.userId,
    teamId: message.teamId,
    channelId: message.channelId,
    threadTs: message.threadTs,
    channelType: facts.channelType,
    isPrivate: facts.isPrivate,
  });
}

async function onInbound(ctx: SlackContext, message: SlackMessage, isDm: boolean): Promise<{ auth: OpenEverywhereSlackAuth | null }> {
  try {
    await ctx.thread.startTyping("Thinking…");
  } catch {
  }
  await setStatusReaction(ctx.slack, "working");
  return { auth: await deriveAuth(ctx, message, isDm) };
}

export default slackChannel({
  onAppMention: (ctx, message) => onInbound(ctx, message, false),
  onDirectMessage: (ctx, message) => onInbound(ctx, message, true),
  events: {
    "session.completed": async (_data, channel) => {
      await setStatusReaction(channel.slack, "done");
      await syncPinnedStatus(channel);
    },
    "session.waiting": async (_data, channel) => {
      await setStatusReaction(channel.slack, "needs_input");
    },
    "session.failed": async (data, channel) => {
      await setStatusReaction(channel.slack, "blocked");
      try {
        await channel.thread.post(`:octagonal_sign: Task failed: ${data.message}`);
      } catch {
      }
      await syncPinnedStatus(channel);
    },
  },
});
