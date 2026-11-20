import type { Partition } from "../memory/partition.js";
import { getThreadEngagement } from "./engagement.js";
import { triggerMessageBody, type WakeAddressing, type WakeFollowUp } from "./wake-envelope.js";

function judgedAddressing(addressing: WakeAddressing): boolean {
  return addressing !== "direct" && addressing !== "direct-mention" && addressing !== "name-drop";
}

export function engagedFollowUpContract(f: {
  readonly addressing: WakeAddressing;
  readonly threadEngaged?: boolean;
}): WakeFollowUp | undefined {
  return judgedAddressing(f.addressing) && f.threadEngaged === true ? "thread-engaged" : undefined;
}

export const ENGAGED_FOLLOW_UP_CONTEXT =
  "You are already engaged in this conversation — an earlier message here addressed you. A later " +
  "message in this same conversation is therefore for you, even when it does not name you again: " +
  "that is what being engaged here means, and it is why this one woke you. Answer it. If the people " +
  "here ask you to stop following the conversation, call `stand_down`.";

export async function conversationEnrolledForSilence(p: Partition, anchor: string | undefined): Promise<boolean> {
  if (!anchor) return false;
  const row = await getThreadEngagement(p, anchor);
  return row !== null && row.participating === true && row.stopped !== true;
}

export const NO_REPLY_ON_ENGAGED_ACTION = "reply.no_reply_addressed_to_other_refused";

export const NO_REPLY_ADDRESSED_TO_OTHER_REFUSAL =
  "You are engaged in this conversation, so a message here is addressed to you — " +
  "`addressed_to_other` is not available on this wake. Answer it. If it asks you nothing and you " +
  "truly have nothing to add, call `no_reply` again with `nothing_to_add`. If it asks a question put " +
  "to another person, call `no_reply` with `other` and say who it is for in `explanation`. If they " +
  "asked you to stop following the conversation, call `stand_down` instead.";

const ENGAGED_WAKE_OPENER_RE = /<wake\b[^>]*\bfollow-up="thread-engaged"[^>]*>/;
const QUESTION_MARK_RE = /\?(?=$|[\s"'’”)\]!*_~])/m;

/**
 * True when a delivered message is ONE `follow-up="thread-engaged"` wake whose trigger holds a
 * question mark. The access instructions say a question in an engaged conversation is addressed to
 * the agent, so `no_reply` refuses the silence reasons that call it unimportant. A message with more
 * than one wake, a wake with no single trigger, or a trigger with no question mark answers false.
 * The test is a heuristic. A `?` inside a word or a URL query does not count. A ternary such as
 * `a ? b : c` or a quoted question counts (a false positive). A full-width or Arabic question mark
 * does not count (a false negative, which leaves the fence open).
 */
export function engagedQuestionWake(delivered: string | undefined): boolean {
  if (delivered === undefined) return false;
  const body = triggerMessageBody(delivered);
  if (body === undefined) return false;
  if (!ENGAGED_WAKE_OPENER_RE.test(delivered)) return false;
  return QUESTION_MARK_RE.test(body);
}

/** The silence reasons that claim an engaged question does not need this agent's answer. */
export const ENGAGED_QUESTION_REFUSED_REASONS: ReadonlySet<string> = new Set(["nothing_to_add", "not_relevant", "awaiting_context"]);

export const NO_REPLY_ON_ENGAGED_QUESTION_ACTION = "reply.no_reply_engaged_question_refused";

export function noReplyEngagedQuestionRefusal(reason: string): string {
  return (
    "You are engaged in this conversation, and this message asks a question — " +
    `\`${reason}\` is not available on this wake. A question in a conversation you are engaged in is ` +
    "addressed to you unless it is put to someone else: answer it. If it is put to another person, " +
    "call `no_reply` with `other` and say who it is for in `explanation`. If another participant " +
    "already answered it, call `no_reply` with `duplicate`. If they asked you to stop following the " +
    "conversation, call `stand_down` instead."
  );
}
