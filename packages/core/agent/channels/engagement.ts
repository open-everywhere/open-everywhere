import { getOperationalStore } from "../operational/provider.js";
import type { EngagementRow } from "../operational/store.js";
import { domainKeyOf, type Partition } from "../memory/partition.js";
import type { WakeReason, WakeTrust, WakeMessageSender } from "./wake-envelope.js";

export const WARM_SILENT_LIMIT = 3;

export interface EngageOpts {
  readonly participating?: boolean;
  readonly ownerToken?: string;
  readonly kind?: "thread" | "spawned";
  readonly engagedBy?: string;
  readonly byOwnPost?: boolean;
}

export function ownPostMustNotRevive(opts: EngageOpts | undefined, stopped: boolean): boolean {
  return opts?.byOwnPost === true && opts.participating === true && stopped;
}

export async function markThreadEngaged(p: Partition, threadTs: string, atIso: string, opts?: EngageOpts): Promise<void> {
  try {
    const { byOwnPost, ...store } = opts ?? {};
    const stopped = byOwnPost === true && store.participating === true ? await isThreadStopped(p, threadTs) : false;
    const effective = ownPostMustNotRevive(opts, stopped) ? { ...store, participating: false, engagedBy: undefined } : store;
    await getOperationalStore().markEngaged(p.org, p.surfaceKey, threadTs, atIso, effective);
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

export async function markThreadStopped(p: Partition, threadTs: string): Promise<boolean> {
  try {
    return await getOperationalStore().markStopped(p.org, p.surfaceKey, threadTs);
  } catch (err) {
    console.warn(`[open-everywhere:engagement] markStopped failed (${p.surfaceKey}/${threadTs}): ${String(err)}`);
    return false;
  }
}

export async function isThreadStopped(p: Partition, anchor: string | undefined): Promise<boolean> {
  if (anchor === undefined || anchor.length === 0) return false;
  return (await getThreadEngagement(p, anchor))?.stopped === true;
}

export function roomEngagementAddress(p: Partition): { readonly partition: Partition; readonly anchor: string } {
  const roomKey = domainKeyOf(p);
  const segs = roomKey.split("/");
  return {
    partition: { ...p, surface: segs[2] ?? p.surface, surfaceKey: roomKey, key: roomKey, domainKey: roomKey },
    anchor: segs[2] ?? p.surface,
  };
}

export async function isThreadEngaged(p: Partition, threadTs: string): Promise<boolean> {
  try {
    return (await getOperationalStore().getEngagement(p.org, p.surfaceKey, threadTs)) !== null;
  } catch (err) {
    console.warn(`[open-everywhere:engagement] getEngagement failed (${p.surfaceKey}/${threadTs}): ${String(err)}`);
    return false;
  }
}

export interface ReplyDeliveryInput {
  readonly isEngaged: boolean;
  readonly stopped?: boolean;
  readonly authorIsBot: boolean;
  readonly isAppMention: boolean;
  readonly inThread: boolean;
  readonly subtype?: string;
}

export const STAND_DOWN_DELIVERY_REFUSAL = "asked to stand down in this thread — @mention to pull the agent back in";

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
  if (input.stopped) return { deliver: false, reason: STAND_DOWN_DELIVERY_REFUSAL };
  return { deliver: true, reason: "engaged thread, human reply — deliver to the live session" };
}

export type ParticipationStatus = "addressed" | "participating" | "uncertain";

export interface ParticipationSignals {
  readonly mention: boolean;
  readonly reason: WakeReason;
  readonly trust: WakeTrust;
  readonly senderKind: WakeMessageSender;
}

export interface ParticipationDecision {
  readonly status: ParticipationStatus;
  readonly conservative: boolean;
  readonly reason: string;
}

export function classifyParticipation(s: ParticipationSignals): ParticipationDecision {
  if (s.mention) return { status: "addressed", conservative: false, reason: "directly @mentioned/addressed" };
  if (s.reason === "dm") return { status: "addressed", conservative: false, reason: "direct message" };
  if (s.reason === "dispatch" || s.reason === "spawn") {
    return { status: "addressed", conservative: false, reason: `harness/agent handed this session owed work (${s.reason})` };
  }
  if (s.senderKind === "bot") return { status: "uncertain", conservative: true, reason: "foreign-bot post, not addressed to you" };
  if (s.trust === "unauth") return { status: "uncertain", conservative: true, reason: "unvouched (unauth) author, not addressed to you" };
  if (s.reason === "thread-activity") {
    return { status: "participating", conservative: false, reason: "reply in a thread you are engaged in" };
  }
  return { status: "uncertain", conservative: true, reason: `ambient ${s.reason} with no direct address` };
}
