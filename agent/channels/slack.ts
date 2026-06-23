import { slackChannel, type SlackContext, type SlackMessage } from "eve/channels/slack";
import {
  buildSlackAuth,
  channelFactsFromInfo,
  channelFactsFromRaw,
  type ChannelFacts,
  type OpenEverywhereSlackAuth,
} from "./slack-identity.js";

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

export default slackChannel({
  async onAppMention(ctx, message) {
    try {
      await ctx.thread.startTyping("Thinking…");
    } catch {
    }
    return { auth: await deriveAuth(ctx, message, false) };
  },
  async onDirectMessage(ctx, message) {
    try {
      await ctx.thread.startTyping("Thinking…");
    } catch {
    }
    return { auth: await deriveAuth(ctx, message, true) };
  },
});
