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
import { resolvePartition, type Partition } from "../memory/partition.js";
import { readTier, ensureTier, writeTier, SURFACE } from "../memory/store.js";
import { upsertUnderSection } from "../memory/markdown.js";
import { slackMode } from "../identity/binding.js";
import { scopeOverBudget } from "../spend/check.js";
import { extractPinnedInstructions, introMessage, instructionBullet, ONBOARDED_MARKER } from "../onboarding/onboarding.js";
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

async function resolveFacts(ctx: SlackContext, message: SlackMessage, isDm: boolean): Promise<ChannelFacts> {
  return isDm
    ? { channelType: "im", isPrivate: true }
    : enrichVisibility(ctx, message.channelId, channelFactsFromRaw(message.raw));
}

function authFromFacts(message: SlackMessage, facts: ChannelFacts): OpenEverywhereSlackAuth | null {
  const author = message.author;
  if (!author) return null;
  return buildSlackAuth({
    userId: author.userId,
    teamId: message.teamId,
    channelId: message.channelId,
    threadTs: message.threadTs,
    channelType: facts.channelType,
    isPrivate: facts.isPrivate,
  });
}

async function maybeOnboard(ctx: SlackContext, p: Partition): Promise<void> {
  try {
    const files = await ensureTier(p, SURFACE);
    if (files[ONBOARDED_MARKER] !== undefined) return;

    let adopted = false;
    try {
      const pins = await ctx.slack.request("pins.list", { channel: ctx.slack.channelId });
      const instructions = extractPinnedInstructions(pins);
      if (instructions) {
        const date = new Date().toISOString().slice(0, 10);
        files["MEMORY.md"] = upsertUnderSection(files["MEMORY.md"] ?? "", "Standing instructions", instructionBullet(instructions, date));
        adopted = true;
      }
    } catch {
    }

    files[ONBOARDED_MARKER] = new Date().toISOString();
    await writeTier(p, SURFACE, files, `onboarding ${p.surfaceKey}`);
    try {
      await ctx.thread.post(introMessage(adopted));
    } catch {
    }
  } catch {
  }
}

function partitionForMessage(message: SlackMessage, facts: ChannelFacts): Partition {
  return resolvePartition({
    channel: { kind: "slack" },
    session: {
      auth: {
        current: {
          attributes: {
            team_id: message.teamId ?? "",
            channel_id: message.channelId,
            channel_type: facts.channelType ?? "",
          },
          principalId: message.author?.userId ?? "",
          principalType: "slack-user",
        },
      },
    },
  });
}

async function onInbound(ctx: SlackContext, message: SlackMessage, isDm: boolean): Promise<{ auth: OpenEverywhereSlackAuth | null }> {
  const facts = await resolveFacts(ctx, message, isDm);
  const mode = slackMode(facts.channelType, message.channelId);

  try {
    const verdict = await scopeOverBudget(partitionForMessage(message, facts), mode, new Date().toISOString());
    if (verdict.over) {
      try {
        await ctx.thread.post(`:no_entry: I'm holding off here — ${verdict.reason}. An admin can raise the budget in the spend config.`);
      } catch {
      }
      return { auth: null };
    }
  } catch {
  }

  if (mode === "channel") {
    await maybeOnboard(ctx, partitionForMessage(message, facts));
  }

  try {
    await ctx.thread.startTyping("Thinking…");
  } catch {
  }
  await setStatusReaction(ctx.slack, "working");
  return { auth: authFromFacts(message, facts) };
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
