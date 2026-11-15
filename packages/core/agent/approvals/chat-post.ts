import { postSurfaceTextStrict } from "../channels/surface-message-ops.js";
import { appendAudit } from "../audit/audit.js";
import { registerActionKind, whereFromScope } from "./actions.js";
import type { ActionKind } from "./types.js";
import { QUOTE_MAX, plainQuote } from "./plain-text.js";
import { channelWords } from "../channels/friendly-ids.js";

export interface ChatPostArgs {
  readonly org: string;
  readonly scopeKey: string;
  readonly platform: string;
  readonly container: string;
  readonly grant: string;
  readonly text: string;
  readonly requestedBy: string;
  /** @deprecated Since OPE-2717 nothing writes or reads it. A card frozen before the deploy can still carry it; it is ignored. OPE-2721 removes it. */
  readonly tainted?: boolean;
}

function summarizePost(args: ChatPostArgs): string[] {
  const lines = [`Post a message into ${args.platform} container ${args.container} (granted by ${args.grant})`, args.text];
  return lines;
}

const chatPost: ActionKind<ChatPostArgs> = {
  kind: "chat.post",
  policy: "member",
  plainSummary: (args) => `Post a message in ${channelWords(args.platform, args.container, undefined, (args.scopeKey ?? "").split("/")[0] || args.platform)}`,
  consequence: (args) => plainQuote(args.text, QUOTE_MAX - 2),
  consequenceQuotes: true,
  summarize: summarizePost,
  async execute(args, decidedBy) {
    let messageId: string;
    try {
      messageId = await postSurfaceTextStrict(args.platform, { channelId: args.container, text: args.text });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`chat.post: the ${args.platform} post into "${args.container}" did not land — ${reason}`);
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
      },
    });
    return `message posted in ${channelWords(args.platform, args.container)}`;
  },
};

registerActionKind(chatPost);
