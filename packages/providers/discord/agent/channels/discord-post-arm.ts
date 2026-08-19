import { discordEditMessage, discordPostMessage, discordThreadForMessage, splitForDiscord } from "./discord-post.js";
import {
  markThreadEngaged,
  deploymentOrg,
  recordOwnPost,
  type PostArm,
  type TargetResolveBag,
  type ReplyTarget,
  type UnifiedWakeOrigin,
  type UnifiedReplyDeps,
  type EditLocus,
} from "@open-everywhere/core/agent/adapter-api.js";

type DiscordTarget = Extract<ReplyTarget, { platform: "discord" }>;
type DiscordOrigin = Extract<UnifiedWakeOrigin, { platform: "discord" }>;

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
};
