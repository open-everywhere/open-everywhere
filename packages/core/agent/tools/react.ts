import { defineTool } from "eve/tools";
import { z } from "zod";
import { bindFrom, currentTurnAddressed, isUnifiedWindowContext, turnOriginPlatform, type BindableContext } from "../identity/binding.js";
import { capabilitiesFor, capabilitiesForPlatform } from "../identity/capabilities.js";
import { bridgeSlackReadCall } from "../channels/slack-bridge.js";
import { swallowRoomOp } from "../channels/egress-spoof.js";
import { postArm, type TargetResolveBag } from "../channels/post-arms.js";
import { auditToolAction } from "../audit/tool-action.js";
import { markReactedThisTurn } from "../channels/react-signal.js";
import { carryFailureSignals, platformFailureClass, platformFailureStatus } from "../channels/platform-failure.js";
import { END_TURN_WITH_SENTINEL_INSTRUCTION } from "../channels/normalized-wake.js";
import { sessionMountedTool } from "../access/window-gated.js";
import { refuseTargetIfStopped, refuseVerbIfStoodDown } from "../channels/stand-down-gate.js";

const EMOJI_NAME_PATTERN = /^[a-z0-9_+-]{1,100}$/;

export function reactResultNote(ctx: BindableContext): string {
  let addressed = false;
  try {
    addressed = currentTurnAddressed(ctx);
  } catch {
    addressed = false;
  }
  return addressed
    ? "The reaction acknowledges only: this message addressed you, so post one short `reply` now. The turn ends when the reply lands."
    : `Turn reply requirement satisfied — the reaction stands as this turn's acknowledgement. ${END_TURN_WITH_SENTINEL_INSTRUCTION}`;
}

const REACT_REASONS = ["ack", "noise"] as const;

const reactEntry = defineTool({
        description:
          "React to a message with an emoji. On a message that did NOT address you, a react " +
          '(e.g. "eyes", "thumbsup", "white_check_mark") CAN BE your whole response — prefer it ' +
          "over a low-content text reply that would just add noise. On a message that ADDRESSED " +
          "you the react only acknowledges: post one short `reply` as well before the turn ends. " +
          'Give the BARE emoji name, no colons (e.g. "thumbsup", not ":thumbsup:"). Defaults to ' +
          "reacting to the message that triggered this turn; pass `ts` to react to a different " +
          "message ts in this channel instead (Slack only — GitHub and Linear ignore `ts`, since a " +
          "reaction always lands on the issue/PR itself there; Discord also ignores `ts` and always " +
          "reacts to the message that triggered this turn). GitHub accepts only its own fixed set " +
          "(+1, -1, laugh, confused, heart, hooray, rocket, eyes, or common aliases like " +
          "thumbsup/tada) and refuses anything else with an error naming the ones it supports.",
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
          ts: z.string().min(1).optional().describe("The message ts to react to (Slack only). Defaults to the message that triggered this turn."),
          reason: z
            .enum(REACT_REASONS)
            .optional()
            .describe(
              'Why you reacted (default "ack"): "ack" — you acknowledge the message ("got it"/"on ' +
                'it"/done), and on a message that addressed you one short `reply` still follows; ' +
                '"noise" — an unaddressed message in a busy thread, where a low-content text reply ' +
                "would just add another line.",
            ),
        }),
        outputSchema: z.object({ reacted: z.boolean(), emoji: z.string(), ts: z.string(), note: z.string() }),
        async execute(input, ctx) {
          await refuseVerbIfStoodDown(ctx as BindableContext, "react");
          {
            const origin = turnOriginPlatform(ctx as BindableContext);
            if (origin !== undefined && !capabilitiesForPlatform(origin).reactions) {
              throw new Error(
                `this wake came from ${origin}, which has no reaction primitive — if acknowledgement is needed, use \`reply\`, otherwise \`no_reply\`.`,
              );
            }
          }
          const binding = bindFrom(ctx);

          if (binding.platform !== "slack") {
            const arm = postArm(binding.platform);
            if (!arm?.resolveReactTarget || !arm.react) {
              throw new Error(
                `this wake came from ${binding.platform}, which has no reaction primitive — if acknowledgement is needed, use \`reply\`, otherwise \`no_reply\`.`,
              );
            }
            const t = binding.target;
            const bag: TargetResolveBag = {
              str: (k: string) => (typeof t?.[k] === "string" && (t[k] as string).length > 0 ? (t[k] as string) : undefined),
              num: (k: string) => (typeof t?.[k] === "number" ? (t[k] as number) : undefined),
              threadTs: binding.threadTs,
              ctx: ctx as BindableContext,
            };
            const target = arm.resolveReactTarget(bag);
            if (!target) {
              throw new Error(
                "react couldn't resolve this conversation — try again from a real issue or thread, not a synthetic context.",
              );
            }
            const reactSwallowed = swallowRoomOp(`a ${binding.platform} react (${input.emoji})`);
            try {
              if (!reactSwallowed) await arm.react(target, input.emoji);
            } catch (err) {
              const status = platformFailureStatus(err);
              await auditToolAction(ctx, `${binding.platform}.react.failed`, {
                failure: platformFailureClass(err),
                ...(status !== undefined ? { status } : {}),
              });
              const msg = String(err instanceof Error ? err.message : err);
              throw carryFailureSignals(err, new Error(`react failed — ${msg}`));
            }
            markReactedThisTurn();
            await auditToolAction(ctx, `${binding.platform}.react`, { emoji: input.emoji, reason: input.reason ?? "ack" });
            return {
              reacted: true,
              emoji: input.emoji,
              ts: "",
              note: reactResultNote(ctx as BindableContext),
            };
          }

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
          if (input.ts !== undefined && input.ts !== binding.threadTs) await refuseTargetIfStopped(ctx as BindableContext, "react", input.ts);
          try {
            await bridgeSlackReadCall("reactions.add", { channel: channelId, name: input.emoji, timestamp: ts });
          } catch (err) {
            const msg = String(err instanceof Error ? err.message : err);
            if (!msg.includes("already_reacted")) {
              const status = platformFailureStatus(err);
              await auditToolAction(ctx, "slack.react.failed", {
                ts,
                failure: platformFailureClass(err),
                ...(status !== undefined ? { status } : {}),
              });
              throw carryFailureSignals(err, new Error(`react failed — ${msg}`));
            }
          }
          markReactedThisTurn();
          await auditToolAction(ctx, "slack.react", { emoji: input.emoji, ts, reason: input.reason ?? "ack" });
          return {
            reacted: true,
            emoji: input.emoji,
            ts,
            note: reactResultNote(ctx as BindableContext),
          };
        },
});

export default sessionMountedTool("react", reactEntry, (ctx) => {
  const c = ctx;
  if (!isUnifiedWindowContext(c) && !capabilitiesFor(c).reactions) return false;
  return true;
});
