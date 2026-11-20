import { randomUUID } from "node:crypto";
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
    const stopped = store.participating === true ? await isThreadStopped(p, threadTs) : false;
    const effective = ownPostMustNotRevive(opts, stopped) ? { ...store, participating: false, engagedBy: undefined } : store;
    await getOperationalStore().markEngaged(p.org, p.surfaceKey, threadTs, atIso, effective);
    if (stopped && effective.participating === true) {
      const after = await getOperationalStore().getEngagement(p.org, p.surfaceKey, threadTs);
      if (after !== null && after.stopped !== true) await clearStandDownAck(p, threadTs);
    }
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
    const removed = await getOperationalStore().disengage(p.org, p.surfaceKey, threadTs);
    if (removed) await clearStandDownAck(p, threadTs);
    return removed;
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

const STAND_DOWN_ACK_PREFIX = "stand-down-ack:";
const STAND_DOWN_ACK_SPENT_PREFIX = "stand-down-ack-spent:";

export const STAND_DOWN_ACK_TTL_MS = 24 * 60 * 60 * 1000;

export type StandDownAck =
  | { readonly kind: "held"; readonly holder: string | null; readonly spent: boolean }
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable" };

export type StandDownAckClaim = "claimed" | "taken" | "unwritable";

function standDownAckRowKey(p: Partition, anchor: string): string {
  return `${STAND_DOWN_ACK_PREFIX}${p.surfaceKey}\n${anchor}`;
}

function standDownAckSpentRowKey(p: Partition, anchor: string, holder: string | null, claim: string | null): string {
  const legacy = `${STAND_DOWN_ACK_SPENT_PREFIX}${p.surfaceKey}\n${anchor}\n${holder ?? ""}`;
  return claim === null ? legacy : `${legacy}\n${claim}`;
}

async function claimRow(p: Partition, rowKey: string, holder: string | null, what: string): Promise<StandDownAckClaim> {
  try {
    const body = JSON.stringify({ holder, claim: randomUUID() });
    const won = await getOperationalStore().putTaskResultIfAbsent(p.org, rowKey, body, new Date().toISOString(), STAND_DOWN_ACK_TTL_MS);
    return won ? "claimed" : "taken";
  } catch (err) {
    console.warn(`[open-everywhere:engagement] stand-down ${what} write failed (${p.surfaceKey}): ${String(err)}`);
    return "unwritable";
  }
}

export async function holdStandDownAck(p: Partition, anchor: string, holder: string | undefined): Promise<StandDownAckClaim> {
  return claimRow(p, standDownAckRowKey(p, anchor), holder ?? null, "ack hold");
}

export async function spendStandDownAck(p: Partition, anchor: string, holder: string | undefined): Promise<void> {
  let claim: string | null = null;
  let readFailed = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await getOperationalStore().getTaskResult(p.org, standDownAckRowKey(p, anchor));
      const hold = raw === null ? undefined : parseHolder(raw);
      if (hold !== undefined && hold.holder === (holder ?? null)) claim = hold.claim;
      readFailed = false;
      break;
    } catch (err) {
      readFailed = true;
      if (attempt === 1) console.warn(`[open-everywhere:engagement] stand-down ack spend could not read the hold (${p.surfaceKey}/${anchor}): ${String(err)}`);
    }
  }
  if (claim === null && !readFailed) console.warn(`[open-everywhere:engagement] stand-down ack spend found no hold of its own (${p.surfaceKey}/${anchor}); the spend is written under the holder key only`);
  await claimRow(p, standDownAckSpentRowKey(p, anchor, holder ?? null, claim), holder ?? null, "ack spend");
}

function parseHolder(raw: string): { readonly holder: string | null; readonly spent: boolean; readonly claim: string | null } | undefined {
  try {
    const parsed = JSON.parse(raw) as { holder?: unknown; spent?: unknown; claim?: unknown };
    return {
      holder: typeof parsed.holder === "string" ? parsed.holder : null,
      spent: parsed.spent === true,
      claim: typeof parsed.claim === "string" && parsed.claim.length > 0 ? parsed.claim : null,
    };
  } catch {
    return undefined;
  }
}

export async function readStandDownAck(p: Partition, anchor: string): Promise<StandDownAck> {
  try {
    const store = getOperationalStore();
    const raw = await store.getTaskResult(p.org, standDownAckRowKey(p, anchor));
    if (raw === null) return { kind: "absent" };
    const hold = parseHolder(raw);
    if (hold === undefined) return { kind: "unreadable" };
    if (hold.spent) return { kind: "held", holder: hold.holder, spent: true };
    const spentAtClaim = (await store.getTaskResult(p.org, standDownAckSpentRowKey(p, anchor, hold.holder, hold.claim))) !== null;
    const spent =
      spentAtClaim || (hold.claim !== null && (await store.getTaskResult(p.org, standDownAckSpentRowKey(p, anchor, hold.holder, null))) !== null);
    return { kind: "held", holder: hold.holder, spent };
  } catch {
    return { kind: "unreadable" };
  }
}

async function clearStandDownAck(p: Partition, anchor: string): Promise<void> {
  try {
    const store = getOperationalStore();
    const raw = await store.getTaskResult(p.org, standDownAckRowKey(p, anchor));
    if (raw === null) return;
    const removed = await store.deleteTaskResultIfUnstopped(p.org, standDownAckRowKey(p, anchor), raw, p.surfaceKey, anchor);
    if (!removed) return;
    const hold = parseHolder(raw);
    if (hold !== undefined) await store.deleteTaskResult(p.org, standDownAckSpentRowKey(p, anchor, hold.holder, hold.claim));
  } catch (err) {
    console.warn(`[open-everywhere:engagement] stand-down ack clear failed (${p.surfaceKey}/${anchor}): ${String(err)}`);
  }
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
