import { getOperationalStore } from "../operational/provider.js";
import type { EngagementRow } from "../operational/store.js";
import type { Partition } from "../memory/partition.js";

export const WARM_SILENT_LIMIT = 3;

export async function markThreadEngaged(
  p: Partition,
  threadTs: string,
  atIso: string,
  opts?: { participating?: boolean; ownerToken?: string; kind?: "thread" | "spawned" },
): Promise<void> {
  try {
    await getOperationalStore().markEngaged(p.org, p.surfaceKey, threadTs, atIso, opts);
  } catch (err) {
    console.warn(`[open-everywhere:engagement] markEngaged failed (${p.surfaceKey}/${threadTs}): ${String(err)}`);
  }
}

export async function getThreadEngagement(p: Partition, threadTs: string): Promise<EngagementRow | null> {
  try {
    return await getOperationalStore().getEngagement(p.org, p.surfaceKey, threadTs);
  } catch (err) {
    console.warn(`[open-everywhere:engagement] getEngagement failed (${p.surfaceKey}/${threadTs}): ${String(err)}`);
    return null;
  }
}

export async function bumpThreadSilentStreak(p: Partition, threadTs: string): Promise<number> {
  try {
    return await getOperationalStore().bumpSilentStreak(p.org, p.surfaceKey, threadTs);
  } catch (err) {
    console.warn(`[open-everywhere:engagement] bumpSilentStreak failed (${p.surfaceKey}/${threadTs}): ${String(err)}`);
    return 0;
  }
}

export async function disengageThread(p: Partition, threadTs: string): Promise<boolean> {
  try {
    return await getOperationalStore().disengage(p.org, p.surfaceKey, threadTs);
  } catch (err) {
    console.warn(`[open-everywhere:engagement] disengage failed (${p.surfaceKey}/${threadTs}): ${String(err)}`);
    return false;
  }
}

export async function isThreadEngaged(p: Partition, threadTs: string): Promise<boolean> {
  try {
    return (await getOperationalStore().getEngagement(p.org, p.surfaceKey, threadTs)) !== null;
  } catch (err) {
    console.warn(`[open-everywhere:engagement] getEngagement failed (${p.surfaceKey}/${threadTs}): ${String(err)}`);
    return false;
  }
}

const STOP_RE =
  /^\s*(?:hey\s+)?(?:please\s+)?(?:stop(?:\s+(?:following|replying|listening|now|here|this\s+thread))?|stand[\s-]*down|disengage|drop\s+(?:out\s+of\s+)?(?:this\s+)?thread|leave\s+(?:this\s+)?thread|you\s+can\s+stop(?:\s+now)?|that'?s\s+all(?:\s+(?:for\s+now|thanks?))?)\s*[.!]*\s*$/i;

export function isStopRequest(text: string): boolean {
  return STOP_RE.test(text.trim());
}

export const STOP_ACK_COPY = "Standing down — I'll stop following this thread. @-mention me to pull me back in.";

export interface ReplyDeliveryInput {
  readonly isEngaged: boolean;
  readonly authorIsBot: boolean;
  readonly isAppMention: boolean;
  readonly inThread: boolean;
  readonly subtype?: string;
}

export interface ReplyDecision {
  readonly deliver: boolean;
  readonly reason: string;
}

export function shouldDeliverReply(input: ReplyDeliveryInput): ReplyDecision {
  if (input.subtype && input.subtype !== "message_changed") {
    return { deliver: false, reason: `message subtype "${input.subtype}" — not a plain reply` };
  }
  if (input.authorIsBot) return { deliver: false, reason: "author is a bot — would self-trigger" };
  if (input.isAppMention) return { deliver: false, reason: "app_mention — handled by the mention path" };
  if (!input.inThread) return { deliver: false, reason: "not a thread reply — engagement is per-thread" };
  if (!input.isEngaged) return { deliver: false, reason: "thread is not engaged — only @mention/DM starts engagement" };
  return { deliver: true, reason: "engaged thread, human reply — deliver to the live session" };
}
