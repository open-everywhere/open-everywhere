import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { bindFrom, isUnifiedWindowContext, turnOriginPlatform, type BindableContext } from "../identity/binding.js";
import { capabilitiesFor, capabilitiesForPlatform } from "../identity/capabilities.js";
import { bridgeSlackReadCall } from "../channels/slack-bridge.js";
import { auditToolAction } from "../audit/tool-action.js";
import { markReactedThisTurn } from "../channels/react-signal.js";
import { noteTerminalCallGrain } from "../channels/turn-terminal-actions.js";
import { preRegisterDynamicEntry } from "../access/window-gated.js";

const EMOJI_NAME_PATTERN = /^[a-z0-9_+-]{1,100}$/;

export const REACT_REASONS = ["ack", "noise"] as const;

const reactEntry = defineTool({
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
          reason: z
            .enum(REACT_REASONS)
            .optional()
            .describe(
              'Why a react is your whole response (default "ack"): "ack" — a bare acknowledgement ' +
                '("got it"/"on it"/done), the react says everything a reply would; "noise" — a busy/noisy ' +
                "thread where a low-content text reply would just add another line.",
            ),
        }),
        outputSchema: z.object({ reacted: z.boolean(), emoji: z.string(), ts: z.string(), note: z.string() }),
        async execute(input, ctx) {
          {
            const origin = turnOriginPlatform(ctx as BindableContext);
            if (origin !== undefined && !capabilitiesForPlatform(origin).reactions) {
              throw new Error(
                `this wake came from ${origin}, which has no reaction primitive — if acknowledgement is needed, use \`reply\`, otherwise \`no_reply\`.`,
              );
            }
          }
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
            await bridgeSlackReadCall("reactions.add", { channel: channelId, name: input.emoji, timestamp: ts });
          } catch (err) {
            const msg = String(err instanceof Error ? err.message : err);
            if (!msg.includes("already_reacted")) {
              throw new Error(`react failed — ${msg}`);
            }
          }
          markReactedThisTurn();
          noteTerminalCallGrain(ctx as BindableContext);
          await auditToolAction(ctx, "slack.react", { emoji: input.emoji, ts, reason: input.reason ?? "ack" });
          return {
            reacted: true,
            emoji: input.emoji,
            ts,
            note: "Turn reply requirement satisfied — the reaction stands as this turn's acknowledgement.",
          };
        },
});
preRegisterDynamicEntry("react", "_single", reactEntry);

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => {
      const c = ctx as BindableContext;
      if (!isUnifiedWindowContext(c) && !capabilitiesFor(c).reactions) return null;
      return reactEntry;
    },
  },
});
