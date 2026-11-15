import { deliverProactiveDm } from "../channels/dm-audience.js";
import { registerActionKind, whereFromScope } from "./actions.js";
import type { ActionKind } from "./types.js";
import { QUOTE_MAX, plainQuote } from "./plain-text.js";
import { personWords, platformName } from "../channels/friendly-ids.js";

export interface ChatDmArgs {
  readonly org: string;
  readonly scopeKey: string;
  readonly platform: string;
  readonly principalId: string;
  readonly recipientLabel?: string;
  readonly grant: string;
  readonly text: string;
  readonly footer: string;
  readonly requestedBy: string;
  /** @deprecated Since OPE-2717 nothing writes or reads it. A card frozen before the deploy can still carry it; it is ignored. OPE-2721 removes it. */
  readonly tainted?: boolean;
}

function recipientWords(args: Pick<ChatDmArgs, "platform" | "principalId" | "recipientLabel">): string {
  const who = personWords({ id: args.principalId, platform: args.platform, ...(args.recipientLabel !== undefined ? { label: args.recipientLabel } : {}) });
  return who === "someone" ? `a ${platformName(args.platform)} person` : who;
}

function summarizeDm(args: ChatDmArgs): string[] {
  const lines = [
    `Start a direct message with ${recipientWords(args)}, whom an operator granted`,
    args.text,
    `They will also see: ${args.footer.trim()}`,
    "Approving this also lets later messages to this person go without a card. They can stop it from their own DM at any time.",
  ];
  return lines;
}

const chatDm: ActionKind<ChatDmArgs> = {
  kind: "chat.dm",
  policy: "member",
  plainSummary: (args) => `Send a direct message to ${recipientWords(args)}`,
  consequence: (args) => `${plainQuote(args.text, QUOTE_MAX - 60)} — later messages to them go without asking`,
  consequenceQuotes: true,
  summarize: summarizeDm,
  async execute(args, decidedBy) {
    await deliverProactiveDm({
      where: whereFromScope(args.org, args.scopeKey),
      plane: "chat.dm",
      platform: args.platform,
      recipientId: args.principalId,
      address: args.grant,
      text: args.text,
      footer: args.footer,
      requestedBy: args.requestedBy,
      attributedTo: decidedBy,
      first: true,
    });
    return `sent a direct message to ${recipientWords(args)}`;
  },
};

registerActionKind(chatDm);
