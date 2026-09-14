import { deliverProactiveDm } from "../channels/dm-audience.js";
import { registerActionKind, whereFromScope } from "./actions.js";
import type { ActionKind } from "./types.js";

export interface ChatDmArgs {
  readonly org: string;
  readonly scopeKey: string;
  readonly platform: string;
  readonly principalId: string;
  readonly grant: string;
  readonly text: string;
  readonly footer: string;
  readonly requestedBy: string;
  readonly tainted?: boolean;
}

function summarizeDm(args: ChatDmArgs): string[] {
  const lines = [
    `Start a direct message with ${args.platform} person ${args.principalId} (granted by ${args.grant})`,
    args.text,
    `They will also see: ${args.footer.trim()}`,
    "Approving this also lets later messages to this person go without a card. They can stop it from their own DM at any time.",
  ];
  if (args.tainted) lines.push("⚠ proposed in a turn that read external content — review before approving");
  return lines;
}

const chatDm: ActionKind<ChatDmArgs> = {
  kind: "chat.dm",
  policy: "member",
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
      ...(args.tainted === undefined ? {} : { tainted: args.tainted }),
    });
    return `sent a direct message to ${args.platform} person ${args.principalId}`;
  },
};

registerActionKind(chatDm);
