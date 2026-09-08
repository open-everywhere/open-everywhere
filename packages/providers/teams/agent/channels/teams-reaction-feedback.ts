import {
  buildIngestedReaction,
  ingestReaction,
  liveReactionSink,
  resolvePartition,
  type ReactionIngestOutcome,
  type ReactionSinkDeps,
} from "@open-everywhere/core/agent/adapter-api.js";
import { buildTeamsAuth } from "./teams-identity.js";
import type { TeamsReactionActivity } from "./teams-stop.js";

export interface TeamsReactionFeedbackDeps {
  readonly sink: ReactionSinkDeps;
}

export function liveTeamsReactionFeedbackDeps(): TeamsReactionFeedbackDeps {
  return { sink: liveReactionSink() };
}

function teamsReactorIsMachine(rx: TeamsReactionActivity): boolean {
  return rx.reactorId === rx.agentId || rx.reactorId?.startsWith("28:") === true;
}

export async function routeTeamsReactionFeedback(
  rx: TeamsReactionActivity,
  deps: TeamsReactionFeedbackDeps,
): Promise<readonly ReactionIngestOutcome[]> {
  if (!rx.reactorId || teamsReactorIsMachine(rx)) return [];
  if (!rx.conversationId) return [];

  const partition = resolvePartition({
    channel: { kind: "teams" },
    session: {
      auth: {
        current: buildTeamsAuth({
          userId: rx.reactorId,
          conversationId: rx.conversationId,
          ...(rx.tenantId ? { tenantId: rx.tenantId } : {}),
          ...(rx.teamsChannelId ? { channelId: rx.teamsChannelId } : {}),
          ...(rx.teamId ? { teamId: rx.teamId } : {}),
          ...(rx.scope ? { scope: rx.scope } : {}),
        }),
      },
    },
  });

  const onBotReply = Boolean(rx.replyToId);
  const outcomes: ReactionIngestOutcome[] = [];
  for (const [verb, emojis] of [
    ["added", rx.added],
    ["removed", rx.removed],
  ] as const) {
    for (const emoji of emojis) {
      const reaction = buildIngestedReaction({
        surface: "teams",
        verb,
        reactorId: rx.reactorId,
        emoji,
        target: { channelId: rx.conversationId, messageId: rx.replyToId ?? "" },
        onBotReply,
        partition,
      });
      outcomes.push(await ingestReaction(reaction, deps.sink));
    }
  }
  return outcomes;
}
