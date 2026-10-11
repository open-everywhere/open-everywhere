import { getOperationalStore } from "../operational/provider.js";
import type { Partition } from "../memory/partition.js";
import type { MeetingPlatform } from "./link.js";

export type MeetingStatus = "approved" | "joining" | "lobby" | "admitted" | "ended" | "failed" | "recapped";

export interface MeetingRecord {
  readonly id: string;
  readonly org: string;
  readonly platform: MeetingPlatform;
  readonly host: string;
  readonly roomId: string;
  readonly requestedBy: string;
  readonly approvedBy: string;
  readonly origin: { readonly platform: string; readonly channelId: string; readonly threadTs: string | null };
  readonly partition: Partition;
  readonly secret: string;
  readonly box: { readonly name: string; readonly backend: string; readonly metered: boolean; readonly createdAt: number; readonly maxMinutes: number; readonly memoryMb: number };
  readonly slot: number;
  readonly status: MeetingStatus;
  readonly createdAt: string;
  readonly endedAt?: string;
  readonly chunks?: number;
}

const RECORD = (id: string): string => `meeting:${id}`;
const CHUNK = (id: string, seq: number): string => `meeting-chunk:${id}:${seq}`;
const DAY_MS = 24 * 60 * 60 * 1000;

export const MEETING_ID = /^mtg_[a-z0-9]{20,40}$/;

export function recordTtlMs(maxMinutes: number, transcriptDays: number): number {
  return maxMinutes * 60_000 + 60 * 60_000 + transcriptDays * DAY_MS;
}

export async function putMeetingRecord(rec: MeetingRecord, ttlMs: number): Promise<void> {
  await getOperationalStore().putTaskResult(rec.org, RECORD(rec.id), JSON.stringify(rec), new Date().toISOString(), ttlMs);
}

export async function getMeetingRecord(org: string, id: string): Promise<MeetingRecord | undefined> {
  if (!MEETING_ID.test(id)) return undefined;
  const raw = await getOperationalStore().getTaskResult(org, RECORD(id));
  if (raw === null) return undefined;
  try {
    const rec = JSON.parse(raw) as MeetingRecord;
    return rec.id === id && rec.org === org ? rec : undefined;
  } catch {
    return undefined;
  }
}

export async function deleteMeetingRecord(org: string, id: string): Promise<void> {
  await getOperationalStore().deleteTaskResult(org, RECORD(id));
}

export interface StoredChunk {
  readonly text: string;
  readonly tail?: string;
  readonly attendees?: readonly string[];
  readonly labelled?: number;
}

export async function putTranscriptChunk(org: string, id: string, seq: number, chunk: StoredChunk | string, ttlMs: number): Promise<void> {
  const c = typeof chunk === "string" ? { text: chunk } : chunk;
  await getOperationalStore().putTaskResult(org, CHUNK(id, seq), JSON.stringify({ seq, ...c }), new Date().toISOString(), ttlMs);
}

function parseChunk(raw: string | null): StoredChunk | undefined {
  if (raw === null) return undefined;
  try {
    const v = JSON.parse(raw) as { text?: unknown; tail?: unknown; attendees?: unknown; labelled?: unknown };
    if (typeof v.text !== "string") return undefined;
    return {
      text: v.text,
      ...(typeof v.tail === "string" ? { tail: v.tail } : {}),
      ...(Array.isArray(v.attendees) ? { attendees: v.attendees.filter((a): a is string => typeof a === "string") } : {}),
      ...(typeof v.labelled === "number" ? { labelled: v.labelled } : {}),
    };
  } catch {
    return undefined;
  }
}

export async function readTranscriptChunk(org: string, id: string, seq: number): Promise<StoredChunk | undefined> {
  if (seq < 0) return undefined;
  return parseChunk(await getOperationalStore().getTaskResult(org, CHUNK(id, seq)));
}

export async function readTranscript(
  org: string,
  id: string,
  count: number,
): Promise<{ readonly text: string; readonly missing: number[]; readonly attendees: string[]; readonly labelled: number }> {
  const parts: string[] = [];
  const missing: number[] = [];
  const attendees: string[] = [];
  let labelled = 0;
  for (let seq = 0; seq < count; seq++) {
    const c = parseChunk(await getOperationalStore().getTaskResult(org, CHUNK(id, seq)));
    if (c === undefined) {
      missing.push(seq);
      continue;
    }
    if (c.text.trim().length > 0) parts.push(c.text.trim());
    for (const a of c.attendees ?? []) if (!attendees.includes(a)) attendees.push(a);
    labelled += c.labelled ?? 0;
  }
  return { text: parts.join("\n"), missing, attendees, labelled };
}

export async function claimMeetingBilling(org: string, id: string, ttlMs: number): Promise<boolean> {
  return await getOperationalStore().putTaskResultIfAbsent(org, `meeting-billed:${id}`, "1", new Date().toISOString(), ttlMs);
}

export async function claimMeetingRecap(org: string, id: string, ttlMs: number): Promise<boolean> {
  return await getOperationalStore().putTaskResultIfAbsent(org, `meeting-recap:${id}`, "1", new Date().toISOString(), ttlMs);
}

export const MAX_OPEN_MEETINGS = 64;
const SLOT = (n: number): string => `meeting-open-slot:${n}`;

export async function claimOpenMeetingSlot(org: string, id: string, ttlMs: number, now: number = Date.now()): Promise<number | undefined> {
  const store = getOperationalStore();
  const value = JSON.stringify({ id, at: now });
  for (let n = 0; n < MAX_OPEN_MEETINGS; n++) {
    if (await store.putTaskResultIfAbsent(org, SLOT(n), value, new Date(now).toISOString(), ttlMs)) return n;
  }
  return undefined;
}

function parseSlot(raw: string | null): { readonly id: string; readonly at: number } | undefined {
  if (raw === null) return undefined;
  try {
    const v = JSON.parse(raw) as { id?: unknown; at?: unknown };
    return typeof v.id === "string" && typeof v.at === "number" ? { id: v.id, at: v.at } : undefined;
  } catch {
    return undefined;
  }
}

export async function openMeetingSlots(org: string): Promise<{ readonly slot: number; readonly id: string; readonly at: number }[]> {
  const store = getOperationalStore();
  const out: { slot: number; id: string; at: number }[] = [];
  for (let n = 0; n < MAX_OPEN_MEETINGS; n++) {
    const v = parseSlot(await store.getTaskResult(org, SLOT(n)));
    if (v !== undefined) out.push({ slot: n, ...v });
  }
  return out;
}

export async function releaseOpenMeetingSlot(org: string, slot: number, id: string): Promise<void> {
  const store = getOperationalStore();
  if (parseSlot(await store.getTaskResult(org, SLOT(slot)))?.id === id) await store.deleteTaskResult(org, SLOT(slot));
}

export async function claimMeetingOpen(org: string, id: string, ttlMs: number): Promise<boolean> {
  return await getOperationalStore().putTaskResultIfAbsent(org, `meeting-opening:${id}`, "1", new Date().toISOString(), ttlMs);
}

export async function releaseMeetingOpen(org: string, id: string): Promise<void> {
  await getOperationalStore().deleteTaskResult(org, `meeting-opening:${id}`);
}

export async function raiseChunkHighWater(org: string, id: string, seq: number, ttlMs: number): Promise<void> {
  const store = getOperationalStore();
  const raw = await store.getTaskResult(org, `meeting-hw:${id}`);
  const prev = raw === null ? -1 : Number(raw);
  if (!(Number.isFinite(prev) && prev >= seq)) await store.putTaskResult(org, `meeting-hw:${id}`, String(seq), new Date().toISOString(), ttlMs);
}

export async function chunkCount(org: string, id: string, reported: number | undefined): Promise<number> {
  const raw = await getOperationalStore().getTaskResult(org, `meeting-hw:${id}`);
  const hw = raw === null ? -1 : Number(raw);
  return Math.max(reported ?? 0, Number.isFinite(hw) ? hw + 1 : 0);
}
