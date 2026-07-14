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
import { getOperationalStore } from "../operational/provider.js";
import { postOnce, outboundKey } from "../operational/post-once.js";
import { statusVerbsFor } from "../memory/domain.js";
import { getConfig } from "../access/config.js";
import { loadConversationContext } from "./slack-context.js";
import { frontSlackChannel, INTERNAL_SLACK_ROUTE } from "./slack-front.js";
import { finalMessageActionForTurn, turnEffectsFor, botDisplayName, isBareStop, slackForm, isSupervisorReplyTurn, deliverSupervisorReply, supervisorTextDelivery, isSupervisorProseLeak, type SupervisorReplyTarget } from "./slack-events.js";
import { capabilitiesForPlatform } from "../identity/capabilities.js";
import { consumeCardPostedThisTurn } from "../approvals/card-signal.js";
import { consumeReactedThisTurn } from "./react-signal.js";
import { consumeRepliedThisTurn } from "./reply-signal.js";
import { postTerminalProse } from "./reply-post.js";
import { markThreadEngaged, disengageThread, getThreadEngagement, bumpThreadSilentStreak, isStopRequest, STOP_ACK_COPY, WARM_SILENT_LIMIT } from "./engagement.js";
import { SURFACE, tierId } from "../memory/store.js";
import { getProvider, providerById } from "../memory/provider.js";
import { upsertUnderSection } from "../memory/markdown.js";
import { slackMode, bindFrom, type BindableContext } from "../identity/binding.js";
import { isAllowedSlackDriver } from "../testing/driver-allowlist.js";
import { planFor } from "../memory/resolve.js";
import { scopeOverBudget } from "../spend/check.js";
import { capBypassFor } from "../spend/bypass.js";
import { extractPinnedInstructions, introMessage, instructionBullet, ONBOARDED_MARKER } from "../onboarding/onboarding.js";
import {
  STATUS_REACTION,
  renderPinned,
  isPinnedStatusMessage,
  type ReactionState,
} from "../status/status.js";

function statusVerb(state: { channelId?: string | null; teamId?: string | null }): string {
  try {
    const p = resolvePartition({
      channel: { kind: "slack" },
      session: { auth: { current: { attributes: { team_id: state.teamId ?? "", channel_id: state.channelId ?? "" }, principalId: "", principalType: "slack-user" } } },
    });
    const cfg = getConfig();
    const verbs = statusVerbsFor(p.surfaceKey, cfg.loadDomains(), cfg.loadRoles?.() ?? []);
    return `${verbs[Math.floor(Math.random() * verbs.length)]}…`;
  } catch {
    return "Working…";
  }
}

async function refreshTypingStatus(channel: SlackEventContext): Promise<void> {
  try {
    await channel.thread.startTyping(statusVerb(channel.state));
  } catch {
  }
}

function isUninvited(state: unknown): boolean {
  return (state as Record<string, unknown> | undefined)?.oeUninvited === true;
}

async function recordQuietFailure(
  state: { channelId?: string | null; teamId?: string | null; threadTs?: string | null },
  event: string,
  message: string,
): Promise<void> {
  console.warn(`[open-everywhere:slack] ${event} on an uninvited turn — suppressed on-surface (${message})`);
  try {
    const p = resolvePartition({
      channel: { kind: "slack" },
      session: { auth: { current: { attributes: { team_id: state.teamId ?? "", channel_id: state.channelId ?? "" }, principalId: "", principalType: "slack-user" } } },
    });
    await getOperationalStore().appendAudit({
      ts: new Date().toISOString(),
      org: p.org,
      platform: p.platform,
      workspace: p.workspace,
      surface: p.surface,
      action: "surface.quiet_fail",
      detail: { event, threadTs: state.threadTs ?? undefined, message: message.slice(0, 500) },
    });
  } catch (err) {
    console.warn(`[open-everywhere:slack] quiet-fail audit write failed: ${String(err)}`);
  }
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
    const files = await getProvider().readTier(p, SURFACE);
    const text = renderPinned(files["STATUS.md"]);

    const slack = channel.slack;
    const list = await slack.request("pins.list", { channel: channelId });
    let ts: string | undefined;
    const items = (list as { items?: unknown }).items;
    if (list.ok && Array.isArray(items)) {
      for (const it of items) {
        const m = (it as { message?: { text?: unknown; ts?: unknown } })?.message;
        if (m && typeof m.text === "string" && isPinnedStatusMessage(m.text) && typeof m.ts === "string") {
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
    const marker = await getProvider().ensureTier(p, SURFACE);
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
    await getProvider().writeTier(p, SURFACE, marker, `onboarding ${p.surfaceKey}`);
    try {
      await ctx.thread.post(introMessage(adopted, await botDisplayName()));
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
  if (message.author?.isBot) {
    const rawBotId = typeof (message.raw as { bot_id?: unknown })?.bot_id === "string" ? (message.raw as { bot_id: string }).bot_id : undefined;
    if (!isAllowedSlackDriver(message.teamId, rawBotId)) return { auth: null };
    console.log(`[open-everywhere:slack] e2e driver accepted: bot-authored mention from ${rawBotId} in team ${message.teamId} (allowlisted)`);
  }
  const facts = await resolveFacts(ctx, message, isDm);
  const mode = slackMode(facts.channelType, message.channelId);

  try {
    const partition = partitionForMessage(message, facts);
    const binding = bindFrom(bindableForMessage(message, facts));
    const verdict = await scopeOverBudget(partition, mode, new Date().toISOString(), binding.trust);
    if (verdict.over) {
      const bypass = await capBypassFor({
        org: binding.org,
        principalId: message.author?.userId,
        surfaceKey: partition.surfaceKey,
        reason: verdict.reason,
      });
      if (bypass) {
        if (bypass.warn) {
          try {
            await ctx.thread.post(
              `:warning: ${verdict.reason} — proceeding because you're an admin. Ask me here to raise or clear the cap (an approval card follows), or change it permanently in the spend-budgets config.`,
            );
          } catch {
          }
        }
      } else {
        try {
          await ctx.thread.post(
            `:no_entry: I'm holding off here — ${verdict.reason}. An admin can raise this permanently in the spend-budgets config, or DM me to propose a temporary override — an admin approves it on a card. Scope keys for the override: this channel = \`${partition.surfaceKey}\`, whole workspace = \`${binding.platform}/${binding.workspace}\`.`,
          );
        } catch {
        }
        return { auth: null };
      }
    }
  } catch {
  }

  if (mode === "channel") {
    await maybeOnboard(ctx, bindableForMessage(message, facts));
  }

  try {
    await ctx.thread.startTyping(statusVerb({ channelId: message.channelId, teamId: message.teamId }));
  } catch {
  }
  await setStatusReaction(ctx.slack, "working");

  if (!isDm && message.author && isStopRequest(message.markdown)) {
    await disengageThread(partitionForMessage(message, facts), message.threadTs);
    try {
      await ctx.thread.post(STOP_ACK_COPY);
    } catch {
    }
    await setStatusReaction(ctx.slack, "none");
    return { auth: null };
  }

  let context: readonly string[] | undefined;
  if (!isDm) {
    context = await loadConversationContext(ctx, message);
    await markThreadEngaged(partitionForMessage(message, facts), message.threadTs, new Date().toISOString(), { participating: true });
  }
  return { auth: authFromFacts(message, facts), context };
}

const slackMentionChannel = slackChannel({
  route: INTERNAL_SLACK_ROUTE,
  onAppMention: (ctx, message) => onInbound(ctx, message, false),
  onDirectMessage: (ctx, message) => onInbound(ctx, message, true),
  events: {
    "turn.started": async (_data, channel, ctx) => {
      if (isSupervisorReplyTurn(channel.state)) {
        const attrs = ctx?.session?.auth?.current?.attributes as Record<string, unknown> | undefined;
        const channelId = typeof attrs?.channel_id === "string" ? attrs.channel_id : undefined;
        const threadTs = typeof attrs?.thread_ts === "string" ? attrs.thread_ts : undefined;
        (channel.state as unknown as Record<string, unknown>).oeReplyTarget = channelId
          ? ({ channelId, threadTs } satisfies SupervisorReplyTarget)
          : undefined;
      }
      channel.state.pendingToolCallMessage = null;
      channel.state.lastReasoningTypingAtMs = null;
      channel.state.lastReasoningTypingStatus = null;
      await channel.thread.startTyping("Working...");
    },
    "reasoning.appended": async (_data, channel) => {
      const now = Date.now();
      const last = channel.state.lastReasoningTypingAtMs;
      if (last != null && now - last >= 0 && now - last < 5000) return;
      channel.state.lastReasoningTypingAtMs = now;
      await refreshTypingStatus(channel);
    },
    "actions.requested": async (_data, channel) => {
      await refreshTypingStatus(channel);
    },
    "message.completed": async (data, channel, ctx) => {
      const sessionId = ctx?.session?.id;
      const action = finalMessageActionForTurn(data.finishReason, data.message);
      if (action.kind === "buffer-tool-status") {
        return;
      }
      const cardPostedThisTurn = consumeCardPostedThisTurn();
      const reactedThisTurn = consumeReactedThisTurn();
      const repliedThisTurn = consumeRepliedThisTurn();
      if (action.kind === "silent") {
        (channel.state as unknown as Record<string, unknown>).oeSilentTurn = true;
        console.log(
          `[open-everywhere:slack] judged silence (${action.reason}) — nothing posted (${channel.state.channelId ?? "?"}/${channel.state.threadTs ?? "?"})`,
        );
        if (isBareStop(action, reactedThisTurn || repliedThisTurn)) {
          const channelId = channel.state.channelId ?? undefined;
          const threadTs = channel.state.threadTs ?? undefined;
          console.warn(
            `[open-everywhere:slack] BARE STOP — turn ended with no reply, no react, and no no_reply ` +
              `(${channelId ?? "?"}/${threadTs ?? "?"}) — this usually means a judgment call went missing, not that one was made.`,
          );
          try {
            const p = resolvePartition({
              channel: { kind: "slack" },
              session: { auth: { current: { attributes: { team_id: channel.state.teamId ?? "", channel_id: channelId ?? "" }, principalId: "", principalType: "slack-user" } } },
            });
            await getOperationalStore().appendAudit({
              ts: new Date().toISOString(),
              org: p.org,
              platform: p.platform,
              workspace: p.workspace,
              surface: p.surface,
              action: "turn.bare_stop",
              detail: { threadTs, ...(sessionId ? { sessionId } : {}) },
            });
          } catch (err) {
            console.warn(`[open-everywhere:slack] bare-stop audit write failed: ${String(err)}`);
          }
        }
        try {
          const { channelId, teamId, threadTs } = channel.state;
          if (channelId && threadTs) {
            const p = resolvePartition({
              channel: { kind: "slack" },
              session: { auth: { current: { attributes: { team_id: teamId ?? "", channel_id: channelId }, principalId: "", principalType: "slack-user" } } },
            });
            const rec = await getThreadEngagement(p, threadTs);
            if (rec && rec.participating !== true) {
              const streak = await bumpThreadSilentStreak(p, threadTs);
              if (streak >= WARM_SILENT_LIMIT) {
                await disengageThread(p, threadTs);
                console.log(
                  `[open-everywhere:slack] warm thread shed after ${streak} silent turns — disengaged (${channelId}/${threadTs})`,
                );
              }
            }
          }
        } catch (err) {
          console.warn(`[open-everywhere:slack] warm silent-streak bookkeeping failed: ${String(err)}`);
        }
        try {
          await channel.thread.startTyping();
        } catch {
        }
        return;
      }
      const effects = turnEffectsFor(action, cardPostedThisTurn);
      if (effects.kind !== "reply") {
        return;
      }
      (channel.state as unknown as Record<string, unknown>).oeSilentTurn = false;
      if (isSupervisorReplyTurn(channel.state)) {
        const target = (channel.state as unknown as Record<string, unknown>).oeReplyTarget as SupervisorReplyTarget | undefined;
        const channelId = channel.state.channelId ?? undefined;
        const teamId = channel.state.teamId;
        const partition = channelId
          ? resolvePartition({
              channel: { kind: "slack" },
              session: { auth: { current: { attributes: { team_id: teamId ?? "", channel_id: channelId }, principalId: "", principalType: "slack-user" } } },
            })
          : undefined;
        const delivery = supervisorTextDelivery(true, capabilitiesForPlatform("slack").midTurnPost);
        if (delivery.droppedProse && isSupervisorProseLeak(true, repliedThisTurn, cardPostedThisTurn)) {
          console.warn(
            `[open-everywhere:slack] supervisor message-tool-only: DROPPED terminal prose (judge emitted text without calling reply) — nothing posted (${channelId ?? "?"}/${target?.threadTs ?? "top-level"})`,
          );
          if (partition) {
            try {
              await getOperationalStore().appendAudit({
                ts: new Date().toISOString(),
                org: partition.org,
                platform: partition.platform,
                workspace: partition.workspace,
                surface: partition.surface,
                action: "turn.supervisor_prose_dropped",
                detail: { threadTs: target?.threadTs, chars: action.text.length, ...(sessionId ? { sessionId } : {}) },
              });
            } catch (err) {
              console.warn(`[open-everywhere:slack] supervisor prose-dropped audit write failed: ${String(err)}`);
            }
          }
        }
        await deliverSupervisorReply({
          postText: delivery.postText,
          text: action.text,
          target,
          async post(cid, tts, text) {
            await postOnce({
              org: partition?.org,
              key: outboundKey({ surface: "slack", channel: cid, threadTs: tts, action: "slack.supervisor-reply", payload: text }),
              run: async () => {
                const body = new URLSearchParams({ channel: cid, text });
                if (tts) body.set("thread_ts", tts);
                await slackForm("chat.postMessage", body.toString());
              },
            });
          },
          async resolveOwnerToken() {
            if (!partition) return undefined;
            try {
              return (await getOperationalStore().getChannelSession(partition.org, partition.surfaceKey))?.token;
            } catch {
              return undefined;
            }
          },
          async bind(tts, ownerToken) {
            if (!partition) return;
            await markThreadEngaged(partition, tts, new Date().toISOString(), { participating: true, ownerToken });
          },
        });
        if (repliedThisTurn || cardPostedThisTurn) {
          (channel.state as unknown as Record<string, unknown>).oeUninvited = false;
        }
        return;
      }
      if (effects.postText) {
        const channelId = channel.state.channelId ?? undefined;
        if (channelId) {
          const p = resolvePartition({
            channel: { kind: "slack" },
            session: { auth: { current: { attributes: { team_id: channel.state.teamId ?? "", channel_id: channelId }, principalId: "", principalType: "slack-user" } } },
          });
          await postTerminalProse(
            { platform: "slack", channelId, ...(channel.state.threadTs ? { threadTs: channel.state.threadTs } : {}) },
            action.text,
            { org: p.org, platform: p.platform, workspace: p.workspace, surface: p.surface, ...(sessionId ? { sessionId } : {}), route: "terminal" },
          );
        } else {
          await channel.thread.post(action.text);
        }
      } else {
        console.log(
          `[open-everywhere:slack] approval card already posted this turn — suppressing the redundant text reply (${channel.state.channelId ?? "?"}/${channel.state.threadTs ?? "?"})`,
        );
      }
      (channel.state as unknown as Record<string, unknown>).oeUninvited = false;
      await setStatusReaction(channel.slack, "none");
      try {
        const { channelId, teamId, threadTs } = channel.state;
        if (channelId && threadTs) {
          const p = resolvePartition({
            channel: { kind: "slack" },
            session: { auth: { current: { attributes: { team_id: teamId ?? "", channel_id: channelId }, principalId: "", principalType: "slack-user" } } },
          });
          await markThreadEngaged(p, threadTs, new Date().toISOString(), { participating: true });
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
    "turn.failed": async (data, channel) => {
      if (isUninvited(channel.state)) {
        await recordQuietFailure(channel.state, "turn.failed", data.message);
        return;
      }
      await setStatusReaction(channel.slack, "blocked");
      try {
        await channel.thread.post(
          `:octagonal_sign: I hit an error while handling your request (${data.message}). Please try again or rephrase.`,
        );
      } catch {
      }
    },
    "session.failed": async (data, channel) => {
      if (isUninvited(channel.state)) {
        await recordQuietFailure(channel.state, "session.failed", data.message);
        return;
      }
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
