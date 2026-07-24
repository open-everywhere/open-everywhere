import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { bindFrom, deploymentOrg, isUnifiedWindowContext, currentWakeId, type BindableContext } from "../identity/binding.js";
import { capabilitiesFor } from "../identity/capabilities.js";
import { resolveReplyTarget, postReply, type ReplyAudit } from "../channels/reply-post.js";
import { markRepliedThisTurn } from "../channels/reply-signal.js";
import { resolveDelegatedReplyTarget } from "../channels/unified-window.js";
import { postUnifiedReply } from "../channels/unified-reply.js";
import { getOperationalStore } from "../operational/provider.js";
import { resolvePartition } from "../memory/partition.js";
import { preRegisterDynamicEntry } from "../access/window-gated.js";
import { gradeReplyFreshness, freshnessRefusalMessage, freshnessNoticeText } from "../channels/reply-freshness.js";

const FORCE_DESCRIPTION =
  "Escape hatch: post even if newer messages have arrived in this conversation since your last " +
  "reply this turn. Default false — only set true when sending immediately matters more than " +
  "reflecting the newer message.";

function replyAuditFor(ctx: BindableContext, route: ReplyAudit["route"], wakeId?: string): ReplyAudit {
  const p = resolvePartition(ctx);
  const sessionId = (ctx as { session?: { id?: string } }).session?.id;
  return {
    org: p.org,
    platform: p.platform,
    workspace: p.workspace,
    surface: p.surface,
    principalId: bindFrom(ctx).principalId,
    ...(sessionId ? { sessionId } : {}),
    ...(wakeId ? { wakeId } : {}),
    route,
  };
}

const unifiedReplyEntry = defineTool({
    description:
      "Post a reply into the conversation a specific wake came from, without ending your turn. " +
      "You are a cross-surface session: each wake envelope carries a `wake-id` naming where it " +
      "came from — pass the wake-id of the message you are answering, and your reply is posted " +
      "into exactly that conversation (its Slack thread, its GitHub issue, …). You cannot " +
      "target anywhere else. Posting is an action, not turn-completion: reply, keep working, " +
      "and finish with `no_reply` when you're done — your terminal text is never posted.",
    inputSchema: z.object({
      text: z.string().min(1).describe("The message to post (the target surface's markdown). One curated message, not a stack."),
      wake: z.string().min(1).describe("The `wake-id` from the envelope of the wake you are answering — your reply posts into that wake's conversation."),
      force: z.boolean().optional().default(false).describe(FORCE_DESCRIPTION),
    }),
    outputSchema: z.object({ posted: z.boolean(), id: z.string(), note: z.string() }),
    async execute(input, ctx) {
      const turnWake = currentWakeId(ctx as BindableContext);
      const resolution = await resolveDelegatedReplyTarget(getOperationalStore(), deploymentOrg(), turnWake, input.wake);
      if (!resolution.ok) {
        if (resolution.reason === "expired") {
          throw new Error(
            `reply couldn't resolve wake-id "${input.wake.slice(0, 64)}" — the wake's reply target is no longer on record (expired). It can't be answered now.`,
          );
        }
        throw new Error(
          `reply: wake-id "${input.wake.slice(0, 64)}" is not the wake you are answering this turn — pass the wake-id from the envelope of the message that woke THIS turn, or one naming the same conversation (a wake-id from an earlier turn or another conversation is refused).`,
        );
      }
      const origin = resolution.origin;

      const freshness = gradeReplyFreshness(ctx as BindableContext, input.force === true);
      if (freshness.kind === "refuse") {
        throw new Error(freshnessRefusalMessage(freshness.newerCount));
      }

      const id = await postUnifiedReply(origin, input.text, {}, replyAuditFor(ctx as BindableContext, "tool", input.wake));
      markRepliedThisTurn();
      const base = `Turn reply requirement satisfied — posted to ${origin.platform}. Keep working if needed; your terminal prose is still discarded.`;
      return {
        posted: true,
        id,
        note: freshness.kind === "notice" ? `${base} ${freshnessNoticeText(freshness.newerCount, input.force === true)}` : base,
      };
    },
});
preRegisterDynamicEntry("reply", "_single", unifiedReplyEntry);

const baseReplyEntry = defineTool({
        description:
          "Post a message into this conversation NOW, without ending your turn. Posting is an " +
          "action, not turn-completion: reply, keep working, and finish with `no_reply` when " +
          "you're done. A reply NOTIFIES the channel — use it for an answer, a question, a " +
          "result, or a blocker, never for a mere progress tick. Posts are FINAL — send fewer, " +
          "curated messages rather than a running status. Posts into the conversation that woke " +
          "you; you can't target another place.",
        inputSchema: z.object({
          text: z.string().min(1).describe("The message to post (channel mrkdwn/markdown). Keep it one curated message, not a stack."),
          force: z.boolean().optional().default(false).describe(FORCE_DESCRIPTION),
        }),
        outputSchema: z.object({ posted: z.boolean(), id: z.string(), note: z.string().optional() }),
        async execute(input, ctx) {
          const target = resolveReplyTarget(ctx);
          if (!target) {
            throw new Error(
              "reply couldn't resolve this conversation — try again from a real channel, thread, or discussion, not a synthetic context.",
            );
          }
          const freshness = gradeReplyFreshness(ctx as BindableContext, input.force === true);
          if (freshness.kind === "refuse") {
            throw new Error(freshnessRefusalMessage(freshness.newerCount));
          }
          const id = await postReply(target, input.text, replyAuditFor(ctx as BindableContext, "tool"));
          markRepliedThisTurn();
          return {
            posted: true,
            id,
            ...(freshness.kind === "notice" ? { note: freshnessNoticeText(freshness.newerCount, input.force === true) } : {}),
          };
        },
});
preRegisterDynamicEntry("reply", "_base", baseReplyEntry);

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => {
      if (isUnifiedWindowContext(ctx as BindableContext)) return unifiedReplyEntry;
      if (!capabilitiesFor(ctx as BindableContext).midTurnPost) return null;
      return baseReplyEntry;
    },
  },
});
