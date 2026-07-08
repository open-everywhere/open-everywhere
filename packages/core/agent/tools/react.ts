import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { channelPlatform, bindFrom, type BindableContext } from "../identity/binding.js";
import { callSlackRead } from "../channels/slack-read.js";
import { auditToolAction } from "../audit/tool-action.js";
import { markReactedThisTurn } from "../channels/react-signal.js";

const EMOJI_NAME_PATTERN = /^[a-z0-9_+-]{1,100}$/;

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => {
      if (channelPlatform(ctx as BindableContext) !== "slack") return null;
      return defineTool({
        description:
          'React to a message with a Slack emoji, instead of (or as) your reply. In a busy or ' +
          'noisy thread, a react (e.g. "eyes", "thumbsup", "white_check_mark") CAN BE your whole ' +
          "response — prefer it over a low-content text reply when a reply would just add noise. " +
          'Give the BARE emoji name, no colons (e.g. "thumbsup", not ":thumbsup:"). Defaults to ' +
          "reacting to the message that triggered this turn; pass `ts` to react to a different " +
          "message ts in this channel instead.",
        inputSchema: z.object({
          emoji: z
            .string()
            .min(1)
            .max(100)
            .refine((v) => EMOJI_NAME_PATTERN.test(v), {
              message:
                'emoji must be a bare Slack emoji name — letters, digits, "_", "+", "-" only, no ' +
                'colons (e.g. "thumbsup", not ":thumbsup:").',
            })
            .describe('Bare Slack emoji name, no colons — e.g. "eyes", "thumbsup", "white_check_mark".'),
          ts: z.string().min(1).optional().describe("The message ts to react to. Defaults to the message that triggered this turn."),
        }),
        outputSchema: z.object({ reacted: z.boolean(), emoji: z.string(), ts: z.string() }),
        async execute(input, ctx) {
          const binding = bindFrom(ctx);
          const channelId = typeof binding.target?.channelId === "string" ? binding.target.channelId : undefined;
          if (!channelId) {
            throw new Error(
              "react couldn't resolve this Slack channel's id — try again from a real channel or DM, not a synthetic context.",
            );
          }
          const ts = input.ts ?? binding.threadTs;
          if (!ts) {
            throw new Error(
              "react needs a message ts — none was given and none could be inferred from this turn.",
            );
          }
          try {
            await callSlackRead("reactions.add", { channel: channelId, name: input.emoji, timestamp: ts });
          } catch (err) {
            const msg = String(err instanceof Error ? err.message : err);
            if (!msg.includes("already_reacted")) {
              throw new Error(`react failed — ${msg}`);
            }
          }
          markReactedThisTurn();
          await auditToolAction(ctx, "slack.react", { emoji: input.emoji, ts });
          return { reacted: true, emoji: input.emoji, ts };
        },
      });
    },
  },
});
