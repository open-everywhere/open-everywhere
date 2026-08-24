import { postSurfaceText } from "../channels/surface-message-ops.js";
import { appendAudit } from "../audit/audit.js";
import { registerActionKind, whereFromScope } from "./actions.js";
import type { ActionKind } from "./types.js";

export interface ChatPostArgs {
  readonly org: string;
  readonly scopeKey: string;
  readonly platform: string;
  readonly container: string;
  readonly grant: string;
  readonly text: string;
  readonly requestedBy: string;
  readonly tainted?: boolean;
}

function summarizePost(args: ChatPostArgs): string[] {
  const lines = [`Post a message into ${args.platform} container ${args.container} (granted by ${args.grant})`, args.text];
  if (args.tainted) lines.push("⚠ proposed in a turn that read external content — review before approving");
  return lines;
}

const chatPost: ActionKind<ChatPostArgs> = {
  kind: "chat.post",
  policy: "member",
  summarize: summarizePost,
  async execute(args, decidedBy) {
    const messageId = await postSurfaceText(args.platform, { channelId: args.container, text: args.text });
    if (messageId === undefined) {
      throw new Error(
        `chat.post: the ${args.platform} post into "${args.container}" did not land. The surface reported no message id — ` +
          `check the bot is a member of that container and that its token carries the post scope.`,
      );
    }
    await appendAudit({
      ...whereFromScope(args.org, args.scopeKey),
      principalId: decidedBy,
      action: "chat.post",
      detail: {
        platform: args.platform,
        container: args.container,
        grant: args.grant,
        messageId,
        requestedBy: args.requestedBy,
        tainted: Boolean(args.tainted),
      },
    });
    return `posted into ${args.platform} container ${args.container}`;
  },
};

registerActionKind(chatPost);
