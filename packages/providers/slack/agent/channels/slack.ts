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
  forwardedSlackEnterpriseId,
  partnerFactsFromInfo,
  slackMode,
  type ChannelFacts,
  type OpenEverywhereSlackAuth,
} from "./slack-identity.js";
import {
  resolvePartition,
  getOperationalStore,
  postOnce,
  outboundKey,
  statusVerbsFor,
  getConfig,
  finalMessageActionForTurn,
  NO_REPLY_SENTINEL_REASON,
  auditNoReplySentinelObserved,
  isBareStop,
  supervisorTextDelivery,
  isSupervisorProseLeak,
  capabilitiesForPlatform,
  consumeCardPostedThisTurn,
  consumeReactedThisTurn,
  consumeRepliedThisTurn,
  dropClosingProse,
  markThreadEngaged,
  disengageThread,
  getThreadEngagement,
  bumpThreadSilentStreak,
  WARM_SILENT_LIMIT,
  SURFACE,
  tierId,
  getProvider,
  providerById,
  writeMemoryTier,
  surfaceProvider,
  upsertUnderSection,
  bindFrom,
  authPrincipalId,
  isAllowedSlackDriver,
  planFor,
  extractPinnedInstructions,
  introMessage,
  instructionBullet,
  ONBOARDED_MARKER,
  STATUS_REACTION,
  renderPinned,
  isPinnedStatusMessage,
  classifyWakeMapping,
  unmappedWakeCopy,
  UNMAPPED_WAKE_DROP_REASON,
  admittedTenantsFromConfig,
  unadmittedTenantLog,
  UNADMITTED_TENANT_DROP_REASON,
  type Partition,
  type BindableContext,
  type ReactionState,
  dmTrustTtlMs,
  swallowRoomOp,
  domainRoster,
} from "@open-everywhere/core/agent/adapter-api.js";
import { loadConversationContext } from "./slack-context.js";
import { slackSpendGate } from "./slack-spend-gate.js";
import { slackTenantAdmission } from "./slack-tenant-fence.js";
import { holdRouteWork } from "./slack-route-hold.js";
import { frontSlackChannel, INTERNAL_SLACK_ROUTE } from "./slack-front.js";
import { admitSlackInputResponse } from "./slack-input-response.js";
import { turnEffectsFor, botDisplayName, slackForm, isSupervisorReplyTurn, deliverSupervisorReply, dmWakeThreadOverride, replyThreadTsForState, type SupervisorReplyTarget } from "./slack-events.js";
import { markdownToSlackMrkdwn } from "./slack-mrkdwn.js";

function teamIdFromDomainConfig(channelId: string | undefined): string | undefined {
  if (!channelId) return undefined;
  try {
    const suffix = `/${channelId}`;
    for (const d of getConfig().loadDomains()) {
      for (const c of domainRoster(d)) {
        if (c.startsWith("slack/") && c.endsWith(suffix)) {
          const team = c.split("/")[1];
          if (team) return team;
        }
      }
    }
  } catch {
  }
  return undefined;
}

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
    await setWakeTyping(channel, statusVerb(channel.state));
  } catch {
  }
}

async function setWakeTyping(channel: SlackEventContext, status?: string): Promise<void> {
  const override = dmWakeThreadOverride(channel.state);
  const channelId = channel.state.channelId ?? undefined;
  if (override && channelId) {
    try {
      const body = new URLSearchParams({ channel_id: channelId, thread_ts: override, status: status ?? "" });
      await slackForm("assistant.threads.setStatus", body.toString());
    } catch {
    }
    return;
  }
  await channel.thread.startTyping(status);
}

async function postWakeText(channel: SlackEventContext, text: string): Promise<void> {
  const override = dmWakeThreadOverride(channel.state);
  const channelId = channel.state.channelId ?? undefined;
  if (override && channelId) {
    const body = new URLSearchParams({ channel: channelId, text, thread_ts: override });
    await slackForm("chat.postMessage", body.toString());
    return;
  }
  await channel.thread.post(text);
}

export function supervisorPostFormBody(channelId: string, threadTs: string | undefined, text: string): string {
  const body = new URLSearchParams({ channel: channelId, text: markdownToSlackMrkdwn(text) });
  if (threadTs) body.set("thread_ts", threadTs);
  return body.toString();
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

async function setStatusReaction(slack: SlackHandle, state: ReactionState | "none", threadTsOverride?: string): Promise<void> {
  const channel = slack.channelId;
  const timestamp = threadTsOverride ?? slack.threadTs;
  if (!channel || !timestamp) return;
  if (swallowRoomOp("a slack status reaction")) return;
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
    const stub = {
      channel: { kind: "slack" as const },
      session: { auth: { current: { attributes: { team_id: teamId ?? "", channel_id: channelId }, principalId: "", principalType: "slack-user" } } },
    };
    const p = resolvePartition(stub);
    const files = await surfaceProvider(bindFrom(stub)).readTier(p, SURFACE);
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

const dmTrustCache = new Map<string, { trust: "internal" | "external"; at: number }>();

async function enrichDmPartner(ctx: SlackContext, message: SlackMessage, base: ChannelFacts): Promise<ChannelFacts> {
  const userId = message.author?.userId;
  if (!userId) return base;
  const hit = dmTrustCache.get(userId);
  if (hit && Date.now() - hit.at < dmTrustTtlMs()) return { ...base, dmPartnerTrust: hit.trust };
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
  const enterpriseId = forwardedSlackEnterpriseId(message);
  return buildSlackAuth({
    userId: author.userId,
    teamId: message.teamId,
    ...(enterpriseId === undefined ? {} : { enterpriseId }),
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
        const mem = await provider.ensureTier(p, target.tier, target.silo, target.access);
        const date = new Date().toISOString().slice(0, 10);
        mem["MEMORY.md"] = upsertUnderSection(mem["MEMORY.md"] ?? "", "Standing instructions", instructionBullet(instructions, date));
        await writeMemoryTier({
          provider,
          partition: p,
          tier: target.tier,
          files: mem,
          message: `adopt pinned instructions [${tierId(target.tier)}]`,
          silo: target.silo,
          access: target.access,
          road: "pinned-instructions",
        });
        adopted = true;
      }
    } catch {
    }

    marker[ONBOARDED_MARKER] = new Date().toISOString();
    await writeMemoryTier({
      provider: getProvider(),
      partition: p,
      tier: SURFACE,
      files: marker,
      message: `onboarding ${p.surfaceKey}`,
      road: "onboarding-marker",
      kind: "operational",
    });
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

type InboundOutcome = { readonly auth: OpenEverywhereSlackAuth | null; readonly context?: readonly string[] } | null;

const DROP = null;

function auditWakeDropped(message: SlackMessage, reason: string, detail: Record<string, unknown> = {}): Promise<void> {
  return holdRouteWork(
    (async () => {
      try {
        const p = resolvePartition({
          channel: { kind: "slack" },
          session: { auth: { current: { attributes: { team_id: message.teamId ?? "", channel_id: message.channelId }, principalId: "", principalType: "slack-user" } } },
        });
        await getOperationalStore().appendAudit({
          ts: new Date().toISOString(),
          org: p.org,
          platform: p.platform,
          workspace: p.workspace,
          surface: p.surface,
          action: "surface.wake_dropped",
          detail: { reason, channel: message.channelId, ts: message.ts, ...detail },
        });
      } catch {
      }
    })(),
  );
}

async function onInbound(
  ctx: SlackContext,
  message: SlackMessage,
  isDm: boolean,
  consult: { gated: boolean },
): Promise<InboundOutcome> {
  if (!message.teamId) {
    const threadTeam = (ctx.thread as { teamId?: string | null }).teamId;
    const healed =
      typeof threadTeam === "string" && threadTeam.length > 0
        ? threadTeam
        :
          teamIdFromDomainConfig(message.channelId);
    if (healed) message = { ...message, teamId: healed };
  }
  if (message.author?.isBot) {
    const rawBotId = typeof (message.raw as { bot_id?: unknown })?.bot_id === "string" ? (message.raw as { bot_id: string }).bot_id : undefined;
    if (!isAllowedSlackDriver(message.teamId, rawBotId)) {
      console.log(
        `[open-everywhere:slack] bot-authored mention dropped — no turn (bot ${rawBotId ?? "?"} in team ${message.teamId ?? "?"} is not an allowlisted e2e driver)`,
      );
      await auditWakeDropped(message, "bot author is not an allowlisted driver", { botId: rawBotId ?? null, team: message.teamId ?? null });
      return DROP;
    }
    console.log(`[open-everywhere:slack] e2e driver accepted: bot-authored mention from ${rawBotId} in team ${message.teamId} (allowlisted)`);
  }
  const facts = await resolveFacts(ctx, message, isDm);
  const mode = slackMode(facts.channelType, message.channelId);

  const mentionEnterpriseId = forwardedSlackEnterpriseId(message);
  if (slackTenantAdmission(message.teamId, mentionEnterpriseId) === "unadmitted") {
    console.log(unadmittedTenantLog("slack", message.teamId, admittedTenantsFromConfig("slack"), mentionEnterpriseId));
    await auditWakeDropped(message, UNADMITTED_TENANT_DROP_REASON, {
      door: "mention",
      team: message.teamId ?? null,
      enterprise: mentionEnterpriseId ?? null,
    });
    return DROP;
  }

  if (classifyWakeMapping({ platform: "slack", mode, workspaceId: message.teamId }) === "unmapped") {
    console.log(
      `[open-everywhere:slack] unmapped-channel wake dropped — no turn (channel ${message.channelId} resolved no team; map it in agent/memory/config/domains.ts)`,
    );
    await auditWakeDropped(message, UNMAPPED_WAKE_DROP_REASON, { door: "mention", channelType: facts.channelType ?? null });
    try {
      await ctx.thread.post(unmappedWakeCopy("slack", message.channelId));
    } catch {
    }
    return DROP;
  }

  const gate = await slackSpendGate({
    bindable: bindableForMessage(message, facts),
    mode,
    principalId: message.author?.userId,
    teamId: message.teamId,
    door: "mention",
    post: async (text) => {
      await ctx.thread.post(text);
    },
  });
  consult.gated = true;
  if (gate === "declined") {
    return DROP;
  }

  if (mode === "channel") {
    await maybeOnboard(ctx, bindableForMessage(message, facts));
  }

  try {
    await ctx.thread.startTyping(statusVerb({ channelId: message.channelId, teamId: message.teamId }));
  } catch {
  }
  await setStatusReaction(ctx.slack, "working");

  let context: readonly string[] | undefined;
  if (!isDm) {
    context = await loadConversationContext(ctx, message);
    await markThreadEngaged(partitionForMessage(message, facts), message.threadTs, new Date().toISOString(), { participating: true });
  }
  return { auth: authFromFacts(message, facts), context };
}

export async function admitInbound(
  ctx: SlackContext,
  message: SlackMessage,
  isDm: boolean,
  run: (consult: { gated: boolean }) => Promise<InboundOutcome> = (consult) => onInbound(ctx, message, isDm, consult),
): Promise<InboundOutcome> {
  const consult = { gated: false };
  const outcome = await run(consult);
  if (outcome === DROP) return DROP;
  if (!consult.gated) {
    console.warn(
      `[open-everywhere:slack] wake admitted without a spend-gate consult — dropped fail-closed (${message.channelId}/${message.ts})`,
    );
    await auditWakeDropped(message, "admitted without a spend-gate consult — fail-closed");
    return DROP;
  }
  return outcome;
}

const slackMentionChannel = slackChannel({
  route: INTERNAL_SLACK_ROUTE,
  turnPolicy: "queue",
  onAppMention: (ctx, message) => admitInbound(ctx, message, false),
  onDirectMessage: (ctx, message) => admitInbound(ctx, message, true),
  onInputResponse: (ctx, submission) => admitSlackInputResponse(ctx, submission),
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
      (channel.state as unknown as Record<string, unknown>).oeReplyPrincipalId = authPrincipalId(ctx);
      {
        const attrs = ctx?.session?.auth?.current?.attributes as Record<string, unknown> | undefined;
        if (attrs?.channel_type === "im") {
          (channel.state as unknown as Record<string, unknown>).oeWakeThreadTs =
            typeof attrs.thread_ts === "string" ? attrs.thread_ts : undefined;
        }
      }
      channel.state.pendingToolCallMessage = null;
      channel.state.lastReasoningTypingAtMs = null;
      channel.state.lastReasoningTypingStatus = null;
      await setWakeTyping(channel, "Working...");
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
      const turnId = (ctx as unknown as { session?: { turn?: { id?: string } } })?.session?.turn?.id;
      const action = finalMessageActionForTurn(data.finishReason, data.message, turnId);
      if (action.kind === "buffer-tool-status") {
        return;
      }
      const cardPostedThisTurn = consumeCardPostedThisTurn();
      const reactedThisTurn = consumeReactedThisTurn();
      const repliedThisTurn = consumeRepliedThisTurn((ctx as unknown as { session?: { turn?: { id?: string } } })?.session?.turn?.id);
      if (action.kind === "silent") {
        (channel.state as unknown as Record<string, unknown>).oeSilentTurn = true;
        console.log(
          `[open-everywhere:slack] judged silence (${action.reason}) — nothing posted (${channel.state.channelId ?? "?"}/${channel.state.threadTs ?? "?"})`,
        );
        if (action.reason === NO_REPLY_SENTINEL_REASON) {
          try {
            const p = resolvePartition({
              channel: { kind: "slack" },
              session: { auth: { current: { attributes: { team_id: channel.state.teamId ?? "", channel_id: channel.state.channelId ?? "" }, principalId: "", principalType: "slack-user" } } },
            });
            await auditNoReplySentinelObserved(p, sessionId);
          } catch (err) {
            console.warn(`[open-everywhere:slack] sentinel no_reply audit write failed: ${String(err)}`);
          }
        }
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
          await setWakeTyping(channel);
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
                await slackForm("chat.postMessage", supervisorPostFormBody(cid, tts, text));
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
            await markThreadEngaged(partition, tts, new Date().toISOString(), { participating: true, ownerToken, byOwnPost: true });
          },
        });
        if (repliedThisTurn || cardPostedThisTurn) {
          (channel.state as unknown as Record<string, unknown>).oeUninvited = false;
        }
        return;
      }
      if (effects.postText) {
        const channelId = channel.state.channelId ?? undefined;
        const replyThreadTs = replyThreadTsForState(channel.state);
        if (channelId) {
          const p = resolvePartition({
            channel: { kind: "slack" },
            session: { auth: { current: { attributes: { team_id: channel.state.teamId ?? "", channel_id: channelId }, principalId: "", principalType: "slack-user" } } },
          });
          await dropClosingProse({
            row: {
              org: p.org,
              platform: p.platform,
              workspace: p.workspace,
              surface: p.surface,
              principalId: (channel.state as unknown as Record<string, unknown>).oeReplyPrincipalId as string | undefined,
            },
            chars: action.text.length,
            ...(sessionId ? { sessionId } : {}),
            anchor: { threadTs: replyThreadTs ?? null },
            log: (m) => console.warn(`[open-everywhere:slack] ${m} (${channelId}/${replyThreadTs ?? "?"})`),
          });
        } else {
          console.warn(
            `[open-everywhere:slack] closing prose DROPPED (${action.text.length}c) — nothing posted, and no partition to audit it under (?/${replyThreadTs ?? "?"})`,
          );
        }
      } else {
        console.log(
          `[open-everywhere:slack] approval card already posted this turn — suppressing the redundant text reply (${channel.state.channelId ?? "?"}/${channel.state.threadTs ?? "?"})`,
        );
      }
      const deliveredThisTurn = repliedThisTurn || cardPostedThisTurn;
      if (deliveredThisTurn) (channel.state as unknown as Record<string, unknown>).oeUninvited = false;
      await setStatusReaction(channel.slack, "none", dmWakeThreadOverride(channel.state));
      try {
        const { channelId, teamId, threadTs } = channel.state;
        if (deliveredThisTurn && channelId && threadTs) {
          const p = resolvePartition({
            channel: { kind: "slack" },
            session: { auth: { current: { attributes: { team_id: teamId ?? "", channel_id: channelId }, principalId: "", principalType: "slack-user" } } },
          });
          await markThreadEngaged(p, threadTs, new Date().toISOString(), { participating: true, byOwnPost: true });
        }
      } catch {
      }
    },
    "session.completed": async (_data, channel) => {
      if ((channel.state as unknown as Record<string, unknown>).oeSilentTurn !== true) {
        await setStatusReaction(channel.slack, "none", dmWakeThreadOverride(channel.state));
      }
      await syncPinnedStatus(channel);
    },
    "session.waiting": async (_data, channel) => {
      if ((channel.state as unknown as Record<string, unknown>).oeSilentTurn === true) return;
      await setStatusReaction(channel.slack, "none", dmWakeThreadOverride(channel.state));
    },
    "turn.failed": async (data, channel) => {
      if (isUninvited(channel.state)) {
        await recordQuietFailure(channel.state, "turn.failed", data.message);
        return;
      }
      await setStatusReaction(channel.slack, "blocked", dmWakeThreadOverride(channel.state));
      try {
        await postWakeText(
          channel,
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
      await setStatusReaction(channel.slack, "blocked", dmWakeThreadOverride(channel.state));
      try {
        await postWakeText(channel, `:octagonal_sign: Task failed: ${data.message}`);
      } catch {
      }
      await syncPinnedStatus(channel);
    },
  },
});

export default frontSlackChannel(slackMentionChannel);
