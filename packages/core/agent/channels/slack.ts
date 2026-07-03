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
  partnerFactsFromInfo,
  type ChannelFacts,
  type OpenEverywhereSlackAuth,
} from "./slack-identity.js";
import { resolvePartition, type Partition } from "../memory/partition.js";
import { loadConversationContext } from "./slack-context.js";
import { frontSlackChannel, INTERNAL_SLACK_ROUTE } from "./slack-front.js";
import { finalMessageAction } from "./slack-events.js";
import { markThreadEngaged, disengageThread, isStopRequest } from "./engagement.js";
import { readTier, ensureTier, writeTier, SURFACE, tierId } from "../memory/store.js";
import { upsertUnderSection } from "../memory/markdown.js";
import { slackMode, bindFrom, type BindableContext } from "../identity/binding.js";
import { planFor } from "../memory/resolve.js";
import { providerById } from "../memory/provider.js";
import { scopeOverBudget } from "../spend/check.js";
import { extractPinnedInstructions, introMessage, instructionBullet, ONBOARDED_MARKER } from "../onboarding/onboarding.js";
import {
  STATUS_REACTION,
  renderPinned,
  PINNED_HEADER,
  type ReactionState,
} from "../status/status.js";

function firstNonEmptyLine(text: string): string | undefined {
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

async function setStatusReaction(slack: SlackHandle, state: ReactionState | "none"): Promise<void> {
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

const DM_TRUST_TTL = Number(process.env.OE_DM_TRUST_TTL_MS) || 5 * 60_000;
const dmTrustCache = new Map<string, { trust: "internal" | "external"; at: number }>();

async function enrichDmPartner(ctx: SlackContext, message: SlackMessage, base: ChannelFacts): Promise<ChannelFacts> {
  const userId = message.author?.userId;
  if (!userId) return base;
  const hit = dmTrustCache.get(userId);
  if (hit && Date.now() - hit.at < DM_TRUST_TTL) return { ...base, dmPartnerTrust: hit.trust };
  try {
    const info = await ctx.slack.request("users.info", { user: userId });
    const { dmPartnerTrust } = partnerFactsFromInfo(info, message.teamId);
    dmTrustCache.set(userId, { trust: dmPartnerTrust, at: Date.now() });
    return { ...base, dmPartnerTrust };
  } catch {
    return base;
  }
}

async function resolveFacts(ctx: SlackContext, message: SlackMessage, isDm: boolean): Promise<ChannelFacts> {
  return isDm
    ? enrichDmPartner(ctx, message, { channelType: "im", isPrivate: true })
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
    isExternal: facts.isExternal,
    trustChecked: facts.trustChecked,
    dmPartnerTrust: facts.dmPartnerTrust,
  });
}

async function maybeOnboard(ctx: SlackContext, where: BindableContext): Promise<void> {
  try {
    const p = resolvePartition(where);
    const marker = await ensureTier(p, SURFACE);
    if (marker[ONBOARDED_MARKER] !== undefined) return;

    let adopted = false;
    try {
      const pins = await ctx.slack.request("pins.list", { channel: ctx.slack.channelId });
      const instructions = extractPinnedInstructions(pins);
      const target = instructions ? planFor(bindFrom(where), p).writes[0] : undefined;
      if (instructions && target) {
        const provider = providerById(target.silo.provider);
        const mem = await provider.ensureTier(p, target.tier, target.silo);
        const date = new Date().toISOString().slice(0, 10);
        mem["MEMORY.md"] = upsertUnderSection(mem["MEMORY.md"] ?? "", "Standing instructions", instructionBullet(instructions, date));
        await provider.writeTier(p, target.tier, mem, `adopt pinned instructions [${tierId(target.tier)}]`, target.silo);
        adopted = true;
      }
    } catch {
    }

    marker[ONBOARDED_MARKER] = new Date().toISOString();
    await writeTier(p, SURFACE, marker, `onboarding ${p.surfaceKey}`);
    try {
      await ctx.thread.post(introMessage(adopted));
    } catch {
    }
  } catch {
  }
}

function bindableForMessage(message: SlackMessage, facts: ChannelFacts): BindableContext {
  const attributes: Record<string, string> = {
    team_id: message.teamId ?? "",
    channel_id: message.channelId,
    channel_type: facts.channelType ?? "",
  };
  if (typeof facts.isExternal === "boolean") attributes.is_ext_shared = String(facts.isExternal);
  if (typeof facts.trustChecked === "boolean") attributes.trust_checked = String(facts.trustChecked);
  if (facts.dmPartnerTrust) attributes.dm_partner_trust = facts.dmPartnerTrust;
  return {
    channel: { kind: "slack" },
    session: { auth: { current: { attributes, principalId: message.author?.userId ?? "", principalType: "slack-user" } } },
  };
}

function partitionForMessage(message: SlackMessage, facts: ChannelFacts): Partition {
  return resolvePartition(bindableForMessage(message, facts));
}

async function onInbound(
  ctx: SlackContext,
  message: SlackMessage,
  isDm: boolean,
): Promise<{ auth: OpenEverywhereSlackAuth | null; context?: readonly string[] }> {
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
    await maybeOnboard(ctx, bindableForMessage(message, facts));
  }

  try {
    await ctx.thread.startTyping("Thinking…");
  } catch {
  }
  await setStatusReaction(ctx.slack, "working");

  if (!isDm && message.author && isStopRequest(message.markdown)) {
    await disengageThread(partitionForMessage(message, facts), message.threadTs);
    try {
      await ctx.thread.post("Standing down — I'll stop following this thread. @-mention me to pull me back in.");
    } catch {
    }
    await setStatusReaction(ctx.slack, "none");
    return { auth: null };
  }

  let context: readonly string[] | undefined;
  if (!isDm) {
    context = await loadConversationContext(ctx, message);
    await markThreadEngaged(partitionForMessage(message, facts), message.threadTs, new Date().toISOString());
  }
  return { auth: authFromFacts(message, facts), context };
}

const slackMentionChannel = slackChannel({
  route: INTERNAL_SLACK_ROUTE,
  onAppMention: (ctx, message) => onInbound(ctx, message, false),
  onDirectMessage: (ctx, message) => onInbound(ctx, message, true),
  events: {
    "reasoning.appended": async (_data, channel) => {
      const now = Date.now();
      const last = channel.state.lastReasoningTypingAtMs;
      if (last != null && now - last >= 0 && now - last < 5000) return;
      channel.state.lastReasoningTypingAtMs = now;
      try {
        await channel.thread.startTyping("Thinking…");
      } catch {
      }
    },
    "actions.requested": async (_data, channel) => {
      const preamble = channel.state.pendingToolCallMessage;
      channel.state.pendingToolCallMessage = null;
      try {
        await channel.thread.startTyping(preamble ? preamble.slice(0, 150) : "Working…");
      } catch {
      }
    },
    "message.completed": async (data, channel) => {
      const action = finalMessageAction(data.finishReason, data.message);
      if (action.kind === "buffer-tool-status") {
        channel.state.pendingToolCallMessage = data.message ? firstNonEmptyLine(data.message) ?? null : null;
        return;
      }
      channel.state.pendingToolCallMessage = null;
      if (action.kind === "silent") {
        (channel.state as unknown as Record<string, unknown>).oeSilentTurn = true;
        try {
          await channel.thread.startTyping();
        } catch {
        }
        return;
      }
      (channel.state as unknown as Record<string, unknown>).oeSilentTurn = false;
      await channel.thread.post(action.text);
      await setStatusReaction(channel.slack, "none");
      try {
        const { channelId, teamId, threadTs } = channel.state;
        if (channelId && threadTs) {
          const p = resolvePartition({
            channel: { kind: "slack" },
            session: { auth: { current: { attributes: { team_id: teamId ?? "", channel_id: channelId }, principalId: "", principalType: "slack-user" } } },
          });
          await markThreadEngaged(p, threadTs, new Date().toISOString());
        }
      } catch {
      }
    },
    "session.completed": async (_data, channel) => {
      if ((channel.state as unknown as Record<string, unknown>).oeSilentTurn !== true) {
        await setStatusReaction(channel.slack, "none");
      }
      await syncPinnedStatus(channel);
    },
    "session.waiting": async (_data, channel) => {
      if ((channel.state as unknown as Record<string, unknown>).oeSilentTurn === true) return;
      await setStatusReaction(channel.slack, "none");
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

export default frontSlackChannel(slackMentionChannel);
