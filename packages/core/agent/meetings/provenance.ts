import { getMeetingRow, putMeetingRow } from "./store.js";
import { meetingPolicy } from "./policy.js";

function unreadableAnswer(): boolean {
  try {
    const p = meetingPolicy();
    return p.enabled || p.native.enabled;
  } catch {
    return true;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
export const MARK_TTL_MS = 3650 * DAY_MS;
export const TOP_LEVEL_MARK_TTL_MS = 7 * DAY_MS;

export interface MeetingPostLocus {
  readonly platform: string;
  readonly channelId: string;
  readonly threadTs: string | null;
}

const POST = (platform: string, container: string, id: string): string => `meeting-post:${platform}:${container}:${id}`;
const THREAD = (platform: string, container: string, root: string): string => `meeting-thread:${platform}:${container}:${root}`;
const TOP = (platform: string, container: string): string => `meeting-top:${platform}:${container}`;
const ANY = "meeting-post-any";
const TURN = (turnKey: string): string => `meeting-turn:${turnKey}`;
const TURN_MARK_TTL_MS = DAY_MS;

export async function markMeetingPostTarget(org: string, locus: MeetingPostLocus, now: number = Date.now()): Promise<void> {
  await putMeetingRow(org, ANY, "1", MARK_TTL_MS, now);
  await putMeetingRow(org, TOP(locus.platform, locus.channelId), "1", TOP_LEVEL_MARK_TTL_MS, now);
  if (locus.threadTs !== null) {
    await putMeetingRow(org, THREAD(locus.platform, locus.channelId, locus.threadTs), "1", MARK_TTL_MS, now);
    return;
  }
  await putMeetingRow(org, THREAD(locus.platform, locus.channelId, locus.channelId), "1", MARK_TTL_MS, now);
}

export async function markMeetingPostId(org: string, locus: MeetingPostLocus, messageId: string, now: number = Date.now()): Promise<void> {
  await putMeetingRow(org, POST(locus.platform, locus.channelId, messageId), "1", MARK_TTL_MS, now);
  if (locus.threadTs === null) await putMeetingRow(org, THREAD(locus.platform, locus.channelId, messageId), "1", MARK_TTL_MS, now);
}

export async function markPostedRecap(org: string, locus: MeetingPostLocus, messageId: string): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await markMeetingPostId(org, locus, messageId);
      return;
    } catch (err) {
      if (attempt === 2) console.warn(`[open-everywhere:meetings] could not mark recap post ${messageId} as untrusted content: ${String(err)}`);
    }
  }
}

export async function chatReadCarriesMeetingPost(
  org: string,
  read: { readonly platform: string; readonly container: string; readonly threadRoot?: string; readonly botMessageIds: readonly string[] },
  now: number = Date.now(),
): Promise<boolean> {
  try {
    if ((await getMeetingRow(org, ANY, now)) === null) return false;
    if (read.threadRoot !== undefined && (await getMeetingRow(org, THREAD(read.platform, read.container, read.threadRoot), now)) !== null) return true;
    for (const id of read.botMessageIds) {
      if ((await getMeetingRow(org, POST(read.platform, read.container, id), now)) !== null) return true;
    }
    return false;
  } catch {
    return unreadableAnswer();
  }
}

export async function turnLocusCarriesMeetingPost(
  org: string,
  locus: { readonly platform: string; readonly container: string; readonly threadRoot?: string },
  now: number = Date.now(),
  turnKey?: string,
): Promise<boolean> {
  let marked: boolean;
  try {
    if ((await getMeetingRow(org, ANY, now)) === null) return false;
    if (turnKey !== undefined && (await getMeetingRow(org, TURN(turnKey), now)) !== null) return true;
    marked = await locusMarked(org, locus, now);
  } catch {
    return unreadableAnswer();
  }
  if (marked && turnKey !== undefined) {
    try {
      await putMeetingRow(org, TURN(turnKey), "1", TURN_MARK_TTL_MS, now);
    } catch (err) {
      console.warn(`[open-everywhere:meetings] could not record a marked turn: ${String(err)}`);
    }
  }
  return marked;
}

async function locusMarked(
  org: string,
  locus: { readonly platform: string; readonly container: string; readonly threadRoot?: string },
  now: number,
): Promise<boolean> {
  if (locus.threadRoot !== undefined && (await getMeetingRow(org, THREAD(locus.platform, locus.container, locus.threadRoot), now)) !== null) return true;
  return (await getMeetingRow(org, TOP(locus.platform, locus.container), now)) !== null;
}
