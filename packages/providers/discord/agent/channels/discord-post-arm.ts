import {
  DISCORD_MESSAGE_MAX,
  discordAddReaction,
  discordEditMessage,
  discordExistingThreadForMessage,
  discordOpenDmChannel,
  discordPostMessage,
  discordPostMessageWithButtons,
  discordThreadForMessage,
  splitForDiscord,
} from "./discord-post.js";
import {
  bindFrom,
  markThreadEngaged,
  deploymentOrg,
  recordOwnPost,
  type PostArm,
  type TargetResolveBag,
  type ReplyTarget,
  type ReactTarget,
  type UnifiedWakeOrigin,
  type UnifiedReplyDeps,
  type EditLocus,
  type DirectMessageRequest,
  type DirectMessageDelivery,
} from "@open-everywhere/core/agent/adapter-api.js";

type DiscordTarget = Extract<ReplyTarget, { platform: "discord" }>;
type DiscordOrigin = Extract<UnifiedWakeOrigin, { platform: "discord" }>;
type DiscordReactTarget = Extract<ReactTarget, { platform: "discord" }>;

async function liveDiscordPost(origin: DiscordOrigin, text: string): Promise<string> {
  let targetChannelId = origin.channelId;
  let anchorToMessage = origin.messageId;
  if (!("dm" in origin) && origin.autoThreadName && origin.messageId) {
    const threadId = await discordThreadForMessage(origin.channelId, origin.messageId, origin.autoThreadName);
    if (threadId) {
      targetChannelId = threadId;
      anchorToMessage = undefined;
      const workspaceKey = `discord/${origin.guildId}`;
      const surfaceKey = `${workspaceKey}/${threadId}`;
      await markThreadEngaged(
        { org: deploymentOrg(), platform: "discord", workspace: origin.guildId, surface: threadId, workspaceKey, surfaceKey, key: surfaceKey },
        threadId,
        new Date().toISOString(),
        { participating: true },
      );
    }
  }
  let first: string | undefined;
  try {
    for (const chunk of splitForDiscord(text)) {
      if (!chunk.trim()) continue;
      const id = await discordPostMessage(targetChannelId, chunk, first === undefined && anchorToMessage ? { replyToMessageId: anchorToMessage } : undefined);
      first ??= id;
    }
  } catch {
    throw new Error(`unified reply couldn't post to Discord — create-message failed on channel ${targetChannelId}`);
  }
  if (first === undefined) {
    throw new Error(`unified reply couldn't post to Discord — nothing to post (empty reply) for channel ${origin.channelId}`);
  }
  if (targetChannelId !== origin.channelId) {
    await recordOwnPost(deploymentOrg(), { platform: "discord", channelId: targetChannelId }, first);
  }
  return first;
}

async function editDiscordMessage(locus: EditLocus, messageId: string, text: string): Promise<void> {
  await discordEditMessage(locus.channelId, messageId, text);
}

async function retargetDiscordEditLocus(origin: UnifiedWakeOrigin, locus: EditLocus): Promise<EditLocus> {
  const o = origin as DiscordOrigin;
  if ("dm" in o || !o.autoThreadName || !o.messageId) return locus;
  const threadId = await discordExistingThreadForMessage(o.channelId, o.messageId);
  return threadId ? { ...locus, channelId: threadId } : locus;
}

async function deliverDiscordDirectMessage(input: DirectMessageRequest): Promise<DirectMessageDelivery> {
  const surfaceId = await discordOpenDmChannel(input.principalId);
  const buttons = (input.actions ?? []).map((a) => ({ customId: a.id, label: a.label, intent: a.intent }));
  if (buttons.length > 0 && input.text.length <= DISCORD_MESSAGE_MAX) {
    return { surfaceId, messageId: await discordPostMessageWithButtons(surfaceId, input.text, buttons) };
  }
  const messageId = await discordPostMessage(surfaceId, input.text);
  return { surfaceId, messageId };
}

export const discordPostArm: PostArm = {
  platform: "discord",
  resolveTarget: (bag: TargetResolveBag): ReplyTarget | null => {
    const channelId = bag.str("channelId");
    return channelId ? { platform: "discord", channelId } : null;
  },
  dispatchReply: (target, text) => discordPostMessage((target as DiscordTarget).channelId, text),
  splitText: (text) => splitForDiscord(text),
  dispatchUnified: (origin, text, deps: UnifiedReplyDeps) => (deps.postDiscord ?? liveDiscordPost)(origin as DiscordOrigin, text),
  describeRedriveTarget: (origin) => `discord channel ${(origin as DiscordOrigin).channelId}`,
  redriveContainerId: (origin) => (origin as DiscordOrigin).channelId,
  editMessage: editDiscordMessage,
  retargetEditLocus: retargetDiscordEditLocus,
  deliverDirectMessage: deliverDiscordDirectMessage,
  resolveReactTarget: (bag: TargetResolveBag): ReactTarget | null => {
    const channelId = bag.str("channelId");
    if (!channelId) return null;
    const messageId = bindFrom(bag.ctx).anchorMessageId;
    return messageId ? { platform: "discord", channelId, messageId } : null;
  },
  react: (target, emoji) => {
    const t = target as DiscordReactTarget;
    return discordAddReaction(t.channelId, t.messageId, emoji);
  },
};
