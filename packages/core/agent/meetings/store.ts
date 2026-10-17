import { createHash } from "node:crypto";
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
  readonly channelLabel?: string;
  readonly serverLabel?: string;
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

const iso = (ms: number): string => new Date(ms).toISOString();

export async function putMeetingRow(org: string, key: string, value: string, ttlMs: number, now: number = Date.now()): Promise<void> {
  await getOperationalStore().putMeetingData(org, key, value, iso(now), iso(now + ttlMs));
}

export async function putMeetingRowIfAbsent(org: string, key: string, value: string, ttlMs: number, now: number = Date.now()): Promise<boolean> {
  return await getOperationalStore().putMeetingDataIfAbsent(org, key, value, iso(now), iso(now + ttlMs));
}

export async function getMeetingRow(org: string, key: string, now: number = Date.now()): Promise<string | null> {
  return await getOperationalStore().getMeetingData(org, key, iso(now));
}

export async function deleteMeetingRow(org: string, key: string): Promise<void> {
  await getOperationalStore().deleteMeetingData(org, key);
}

export async function sweepExpiredMeetingRows(org: string, now: number = Date.now()): Promise<number> {
  return await getOperationalStore().sweepMeetingData(org, iso(now));
}

const RECORD = (id: string): string => `meeting:${id}`;
const CHUNK = (id: string, seq: number): string => `meeting-chunk:${id}:${seq}`;
const DAY_MS = 24 * 60 * 60 * 1000;

export const MEETING_ID = /^mtg_[a-z0-9]{20,40}$/;

export function recordTtlMs(maxMinutes: number, transcriptDays: number): number {
  return maxMinutes * 60_000 + 60 * 60_000 + transcriptDays * DAY_MS;
}

export async function putMeetingRecord(rec: MeetingRecord, ttlMs: number): Promise<void> {
  await putMeetingRow(rec.org, RECORD(rec.id), JSON.stringify(rec), ttlMs);
}

export async function getMeetingRecord(org: string, id: string): Promise<MeetingRecord | undefined> {
  if (!MEETING_ID.test(id)) return undefined;
  const raw = await getMeetingRow(org, RECORD(id));
  if (raw === null) return undefined;
  try {
    const rec = JSON.parse(raw) as MeetingRecord;
    return rec.id === id && rec.org === org ? rec : undefined;
  } catch {
    return undefined;
  }
}

export async function deleteMeetingRecord(org: string, id: string): Promise<void> {
  await deleteMeetingRow(org, RECORD(id));
}

export interface StoredChunk {
  readonly text: string;
  readonly tail?: string;
  readonly attendees?: readonly string[];
  readonly labelled?: number;
  readonly atMs?: number;
}

export async function putTranscriptChunk(org: string, id: string, seq: number, chunk: StoredChunk | string, ttlMs: number): Promise<void> {
  const c = typeof chunk === "string" ? { text: chunk } : chunk;
  await putMeetingRow(org, CHUNK(id, seq), JSON.stringify({ seq, ...c }), ttlMs);
}

function parseChunk(raw: string | null): StoredChunk | undefined {
  if (raw === null) return undefined;
  try {
    const v = JSON.parse(raw) as { text?: unknown; tail?: unknown; attendees?: unknown; labelled?: unknown; atMs?: unknown };
    if (typeof v.text !== "string") return undefined;
    return {
      text: v.text,
      ...(typeof v.tail === "string" ? { tail: v.tail } : {}),
      ...(Array.isArray(v.attendees) ? { attendees: v.attendees.filter((a): a is string => typeof a === "string") } : {}),
      ...(typeof v.labelled === "number" ? { labelled: v.labelled } : {}),
      ...(typeof v.atMs === "number" && Number.isFinite(v.atMs) ? { atMs: v.atMs } : {}),
    };
  } catch {
    return undefined;
  }
}

export async function readTranscriptChunk(org: string, id: string, seq: number): Promise<StoredChunk | undefined> {
  if (seq < 0) return undefined;
  return parseChunk(await getMeetingRow(org, CHUNK(id, seq)));
}

export async function readTranscript(
  org: string,
  id: string,
  count: number,
): Promise<{ readonly text: string; readonly missing: number[]; readonly attendees: string[]; readonly labelled: number }> {
  const chunks: { readonly seq: number; readonly chunk: StoredChunk }[] = [];
  const missing: number[] = [];
  const attendees: string[] = [];
  let labelled = 0;
  for (let seq = 0; seq < count; seq++) {
    const c = parseChunk(await getMeetingRow(org, CHUNK(id, seq)));
    if (c === undefined) {
      missing.push(seq);
      continue;
    }
    chunks.push({ seq, chunk: c });
    for (const a of c.attendees ?? []) if (!attendees.includes(a)) attendees.push(a);
    labelled += c.labelled ?? 0;
  }
  return { text: transcriptOrder(chunks).map((c) => c.text.trim()).filter((t) => t.length > 0).join("\n"), missing, attendees, labelled };
}

export function transcriptOrder(chunks: readonly { readonly seq: number; readonly chunk: StoredChunk }[]): StoredChunk[] {
  const timed = chunks.length > 0 && chunks.every((c) => c.chunk.atMs !== undefined);
  const sorted = [...chunks].sort((a, b) => (timed ? a.chunk.atMs! - b.chunk.atMs! : 0) || a.seq - b.seq);
  return sorted.map((c) => c.chunk);
}

export async function claimMeetingBilling(org: string, id: string, ttlMs: number): Promise<boolean> {
  return await putMeetingRowIfAbsent(org, `meeting-billed:${id}`, "1", ttlMs);
}

export async function claimMeetingRecap(org: string, id: string, ttlMs: number): Promise<boolean> {
  return await putMeetingRowIfAbsent(org, `meeting-recap:${id}`, "1", ttlMs);
}

export const MAX_OPEN_MEETINGS = 64;
const SLOT = (n: number): string => `meeting-open-slot:${n}`;

export async function claimOpenMeetingSlot(org: string, id: string, ttlMs: number, now: number = Date.now()): Promise<number | undefined> {
  const value = JSON.stringify({ id, at: now });
  for (let n = 0; n < MAX_OPEN_MEETINGS; n++) {
    if (await putMeetingRowIfAbsent(org, SLOT(n), value, ttlMs, now)) return n;
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
  const out: { slot: number; id: string; at: number }[] = [];
  for (let n = 0; n < MAX_OPEN_MEETINGS; n++) {
    const v = parseSlot(await getMeetingRow(org, SLOT(n)));
    if (v !== undefined) out.push({ slot: n, ...v });
  }
  return out;
}

export async function releaseOpenMeetingSlot(org: string, slot: number, id: string): Promise<void> {
  if (parseSlot(await getMeetingRow(org, SLOT(slot)))?.id === id) await deleteMeetingRow(org, SLOT(slot));
}

export async function claimMeetingOpen(org: string, id: string, ttlMs: number): Promise<boolean> {
  return await putMeetingRowIfAbsent(org, `meeting-opening:${id}`, "1", ttlMs);
}

export async function releaseMeetingOpen(org: string, id: string): Promise<void> {
  await deleteMeetingRow(org, `meeting-opening:${id}`);
}

export async function raiseChunkHighWater(org: string, id: string, seq: number, ttlMs: number): Promise<void> {
  const raw = await getMeetingRow(org, `meeting-hw:${id}`);
  const prev = raw === null ? -1 : Number(raw);
  if (!(Number.isFinite(prev) && prev >= seq)) await putMeetingRow(org, `meeting-hw:${id}`, String(seq), ttlMs);
}

export async function chunkCount(org: string, id: string, reported: number | undefined): Promise<number> {
  const raw = await getMeetingRow(org, `meeting-hw:${id}`);
  const hw = raw === null ? -1 : Number(raw);
  return Math.max(reported ?? 0, Number.isFinite(hw) ? hw + 1 : 0);
}

export interface VoiceCredentials {
  readonly guildId: string;
  readonly channelId: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly token: string;
  readonly endpoint: string;
}

export interface VoiceMember {
  readonly id: string;
  readonly name: string;
}

export interface VoiceSession {
  readonly credentials?: VoiceCredentials;
  readonly members?: readonly VoiceMember[];
  readonly roster?: readonly VoiceMember[];
  readonly failed?: string;
  readonly at: number;
}

const VOICE = (id: string): string => `meeting-voice:${id}`;

export async function putVoiceSession(org: string, id: string, session: VoiceSession, ttlMs: number): Promise<void> {
  await putMeetingRow(org, VOICE(id), JSON.stringify(session), ttlMs);
}

export async function getVoiceSession(org: string, id: string): Promise<VoiceSession | undefined> {
  if (!MEETING_ID.test(id)) return undefined;
  const raw = await getMeetingRow(org, VOICE(id));
  if (raw === null) return undefined;
  try {
    const v = JSON.parse(raw) as VoiceSession;
    return typeof v.at === "number" ? v : undefined;
  } catch {
    return undefined;
  }
}

export async function deleteVoiceSession(org: string, id: string): Promise<void> {
  await deleteMeetingRow(org, VOICE(id));
}

const STALE_GUILD_CLAIM_MS = 30 * 60_000;

function parseGuildClaim(raw: string | null): { readonly id: string; readonly at: number } | undefined {
  if (raw === null) return undefined;
  try {
    const v = JSON.parse(raw) as { id?: unknown; at?: unknown };
    return typeof v.id === "string" && typeof v.at === "number" ? { id: v.id, at: v.at } : undefined;
  } catch {
    return undefined;
  }
}

export async function claimDiscordGuild(org: string, guildId: string, id: string, ttlMs: number, now: number = Date.now()): Promise<boolean> {
  const key = `meeting-guild:${guildId}`;
  const value = JSON.stringify({ id, at: now });
  if (await putMeetingRowIfAbsent(org, key, value, ttlMs, now)) return true;
  const raw = await getMeetingRow(org, key, now);
  const holder = parseGuildClaim(raw);
  if (holder?.id === id) return true;
  if (holder !== undefined) {
    const rec = await getMeetingRecord(org, holder.id);
    const over = rec !== undefined && (rec.status === "ended" || rec.status === "recapped" || rec.status === "failed");
    const dead = rec === undefined && now - holder.at > STALE_GUILD_CLAIM_MS && !(await openMeetingSlots(org)).some((s) => s.id === holder.id);
    if (!over && !dead) return false;
  }
  const staleTag = createHash("sha256").update(raw ?? "").digest("hex").slice(0, 32);
  if (!(await putMeetingRowIfAbsent(org, `meeting-guild-reclaim:${guildId}:${staleTag}`, id, ttlMs, now))) return false;
  await deleteMeetingRow(org, key);
  return await putMeetingRowIfAbsent(org, key, value, ttlMs, now);
}

export async function releaseDiscordGuild(org: string, guildId: string, id: string): Promise<void> {
  if (parseGuildClaim(await getMeetingRow(org, `meeting-guild:${guildId}`))?.id === id) await deleteMeetingRow(org, `meeting-guild:${guildId}`);
}
