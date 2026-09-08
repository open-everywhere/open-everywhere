import {
  buildIngestedReaction,
  ingestReaction,
  liveReactionSink,
  resolvePartition,
  type ReactionIngestOutcome,
  type ReactionSinkDeps,
} from "@open-everywhere/core/agent/adapter-api.js";
import { buildLinearAuth } from "./linear-identity.js";
import { isLinearStopHand, type LinearReactionEvent } from "./linear-stop.js";

export interface LinearReactionFeedbackDeps {
  readonly sink: ReactionSinkDeps;
  readonly appUserId: (organizationId?: string) => Promise<string | undefined>;
  readonly commentAuthorId: (commentId: string) => Promise<string | undefined>;
}

export type LinearReactionFeedbackOutcome =
  | { readonly ingested: false; readonly reason: string }
  | { readonly ingested: true; readonly outcome: ReactionIngestOutcome };

export async function routeLinearReactionFeedback(
  rx: LinearReactionEvent,
  deps: LinearReactionFeedbackDeps,
): Promise<LinearReactionFeedbackOutcome> {
  if (rx.verb === "added" && isLinearStopHand(rx.emoji)) {
    return { ingested: false, reason: "the stop glyph is a mechanism, not feedback" };
  }
  if (!rx.organizationId) return { ingested: false, reason: "no organization — cannot key the surface" };
  if (!rx.reactorId) return { ingested: false, reason: "no reactor id — nothing to attribute" };
  if (!rx.issueId) return { ingested: false, reason: "no issue — cannot key the surface" };

  const appUser = await deps.appUserId(rx.organizationId).catch(() => undefined);
  if (appUser && rx.reactorId === appUser) {
    return { ingested: false, reason: "the reactor is the app itself — ignored (not feedback)" };
  }

  const author = rx.commentId ? await deps.commentAuthorId(rx.commentId).catch(() => undefined) : undefined;
  const onBotReply = Boolean(appUser) && author === appUser;

  const partition = resolvePartition({
    channel: { kind: "linear" },
    session: { auth: { current: buildLinearAuth({ organizationId: rx.organizationId, issueId: rx.issueId }) } },
  });
  const reaction = buildIngestedReaction({
    surface: "linear",
    verb: rx.verb,
    reactorId: rx.reactorId,
    emoji: rx.emoji,
    target: { channelId: rx.issueId, messageId: rx.commentId ?? "" },
    onBotReply,
    partition,
  });
  return { ingested: true, outcome: await ingestReaction(reaction, deps.sink) };
}

export function liveLinearReactionFeedbackDeps(lookups: {
  readonly appUserId: (organizationId?: string) => Promise<string | undefined>;
  readonly commentAuthorId: (commentId: string) => Promise<string | undefined>;
}): LinearReactionFeedbackDeps {
  return { sink: liveReactionSink(), appUserId: lookups.appUserId, commentAuthorId: lookups.commentAuthorId };
}
