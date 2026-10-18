const TEAMS_REPLY_CHAIN_SUFFIX = ";messageid=";

export function teamsChannelGrainConversationId(conversationId: string): string {
  const i = conversationId.lastIndexOf(TEAMS_REPLY_CHAIN_SUFFIX);
  return i < 0 ? conversationId : conversationId.slice(0, i);
}

export function teamsReplyChainRoot(conversationId: string): string | undefined {
  const i = conversationId.lastIndexOf(TEAMS_REPLY_CHAIN_SUFFIX);
  if (i < 0) return undefined;
  const root = conversationId.slice(i + TEAMS_REPLY_CHAIN_SUFFIX.length);
  return root.length > 0 ? root : undefined;
}

export function isTeamsChannelConversationId(conversationId: string): boolean {
  return /@thread\.(tacv2|skype)$/.test(teamsChannelGrainConversationId(conversationId));
}
