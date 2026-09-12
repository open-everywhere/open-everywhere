import type { Partition } from "../memory/partition.js";
import { getThreadEngagement } from "./engagement.js";
import type { WakeAddressing, WakeFollowUp } from "./wake-envelope.js";

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
  "`addressed_to_other` is not available on this wake. Answer it, or, if you truly have nothing to " +
  "add, call `no_reply` again with `nothing_to_add`. If they asked you to stop following the " +
  "conversation, call `stand_down` instead.";
