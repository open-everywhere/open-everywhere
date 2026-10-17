import { friendlyScopeLabel } from "../approvals/scope-label.js";
import { meetingPolicy, type MeetingPolicy } from "./policy.js";
import { SNOWFLAKE } from "./link.js";
import { cleanSpeakerName, MAX_ATTENDEES } from "./speakers.js";
import { getMeetingRecord, getVoiceSession, openMeetingSlots, putVoiceSession, recordTtlMs, type MeetingRecord, type VoiceCredentials, type VoiceMember } from "./store.js";

export const VOICE_SYNC_ACTIVE_MS = 3_000;
export const VOICE_SYNC_READY_MS = 10_000;
export const VOICE_SYNC_IDLE_MS = 300_000;

export const VOICE_FAILURES = ["stage-channel", "no-permission", "not-found", "not-voice", "join-timeout"] as const;
export type VoiceFailure = (typeof VOICE_FAILURES)[number];

export interface RelayVoiceReport {
  readonly meetingId: string;
  readonly credentials?: VoiceCredentials;
  readonly members?: readonly VoiceMember[];
  readonly failed?: VoiceFailure;
}

export interface VoiceSyncReport {
  readonly relayId: string;
  readonly sessions: readonly RelayVoiceReport[];
}

export interface DesiredVoice {
  readonly meetingId: string;
  readonly guildId: string;
  readonly channelId: string;
  readonly deadlineMs: number;
}

export interface VoiceSyncAnswer {
  readonly voice: readonly DesiredVoice[];
  readonly nextPollMs: number;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const TOKENISH = /^[A-Za-z0-9._:-]{1,256}$/;
const ENDPOINT = /^[a-z0-9.-]{1,253}(:\d{1,5})?$/i;
const MAX_SESSIONS = 64;

function parseCredentials(v: unknown): VoiceCredentials | undefined {
  if (!isObject(v)) return undefined;
  const { guildId, channelId, userId, sessionId, token, endpoint } = v;
  if (typeof guildId !== "string" || !SNOWFLAKE.test(guildId)) return undefined;
  if (typeof channelId !== "string" || !SNOWFLAKE.test(channelId)) return undefined;
  if (typeof userId !== "string" || !SNOWFLAKE.test(userId)) return undefined;
  if (typeof sessionId !== "string" || !TOKENISH.test(sessionId)) return undefined;
  if (typeof token !== "string" || !TOKENISH.test(token)) return undefined;
  if (typeof endpoint !== "string" || !ENDPOINT.test(endpoint)) return undefined;
  return { guildId, channelId, userId, sessionId, token, endpoint };
}

export function mergeRoster(roster: readonly VoiceMember[] | undefined, members: readonly VoiceMember[] | undefined): VoiceMember[] {
  const out = [...(roster ?? [])];
  for (const m of members ?? []) {
    const at = out.findIndex((r) => r.id === m.id);
    if (at >= 0) out[at] = m;
    else if (out.length < MAX_ATTENDEES) out.push(m);
  }
  return out;
}

export function parseVoiceMembers(v: unknown): VoiceMember[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: VoiceMember[] = [];
  for (const raw of v) {
    if (!isObject(raw) || typeof raw.id !== "string" || !SNOWFLAKE.test(raw.id)) continue;
    const name = cleanSpeakerName(raw.name);
    if (name === undefined || out.some((m) => m.id === raw.id)) continue;
    out.push({ id: raw.id, name });
    if (out.length >= MAX_ATTENDEES) break;
  }
  return out;
}

export function parseVoiceSync(raw: unknown): VoiceSyncReport | null {
  if (!isObject(raw) || raw.source !== "discord-gateway-relay" || raw.event !== "VOICE_SYNC") return null;
  const voice = raw.voice;
  if (!isObject(voice) || typeof voice.relayId !== "string" || !SNOWFLAKE.test(voice.relayId)) return null;
  const sessions: RelayVoiceReport[] = [];
  for (const s of Array.isArray(voice.sessions) ? voice.sessions.slice(0, MAX_SESSIONS) : []) {
    if (!isObject(s) || typeof s.meetingId !== "string") continue;
    const credentials = parseCredentials(s.credentials);
    const members = parseVoiceMembers(s.members);
    const failed = typeof s.failed === "string" && (VOICE_FAILURES as readonly string[]).includes(s.failed) ? (s.failed as VoiceFailure) : undefined;
    sessions.push({ meetingId: s.meetingId, ...(credentials !== undefined ? { credentials } : {}), ...(members !== undefined ? { members } : {}), ...(failed !== undefined ? { failed } : {}) });
  }
  return { relayId: voice.relayId, sessions };
}

export function discordRoom(rec: Pick<MeetingRecord, "platform" | "roomId">): { readonly guildId: string; readonly channelId: string } | undefined {
  if (rec.platform !== "discord") return undefined;
  const [guildId, channelId, extra] = rec.roomId.split("/");
  if (guildId === undefined || channelId === undefined || extra !== undefined || !SNOWFLAKE.test(guildId) || !SNOWFLAKE.test(channelId)) return undefined;
  return { guildId, channelId };
}

export interface DiscordRoomLabels {
  readonly channelLabel?: string;
  readonly serverLabel?: string;
}

export async function discordRoomLabels(roomId: string, label: (scopeKey: string) => Promise<string | undefined> = friendlyScopeLabel): Promise<DiscordRoomLabels> {
  const room = discordRoom({ platform: "discord", roomId });
  if (room === undefined) return {};
  const [channelLabel, serverLabel] = await Promise.all([label(`discord/${room.guildId}/${room.channelId}`), label(`discord/${room.guildId}`)]);
  return { ...(channelLabel ? { channelLabel } : {}), ...(serverLabel ? { serverLabel } : {}) };
}

export function discordRoomWords(labels: DiscordRoomLabels): string {
  if (labels.channelLabel === undefined) return labels.serverLabel !== undefined ? `a voice channel on ${labels.serverLabel}` : "a Discord voice channel";
  return labels.serverLabel !== undefined ? `the voice channel ${labels.channelLabel} on ${labels.serverLabel}` : `the voice channel ${labels.channelLabel}`;
}

const OPEN = new Set(["approved", "joining", "lobby", "admitted"]);

export async function openDiscordMeetings(org: string): Promise<{ readonly rec: MeetingRecord; readonly guildId: string; readonly channelId: string }[]> {
  const out: { rec: MeetingRecord; guildId: string; channelId: string }[] = [];
  for (const { id } of await openMeetingSlots(org)) {
    const rec = await getMeetingRecord(org, id);
    if (rec === undefined || !OPEN.has(rec.status)) continue;
    const room = discordRoom(rec);
    if (room !== undefined) out.push({ rec, ...room });
  }
  return out;
}

export interface VoiceSyncDeps {
  readonly policy?: MeetingPolicy;
  readonly now?: () => number;
}

export async function syncDiscordVoice(org: string, report: VoiceSyncReport, deps: VoiceSyncDeps = {}): Promise<VoiceSyncAnswer> {
  const policy = deps.policy ?? meetingPolicy();
  const now = (deps.now ?? Date.now)();
  const open = await openDiscordMeetings(org);
  const voice: DesiredVoice[] = [];
  for (const { rec, guildId, channelId } of open) {
    const ttl = recordTtlMs(rec.box.maxMinutes, policy.retention.transcriptDays);
    const prior = await getVoiceSession(org, rec.id);
    let session = prior;
    const r = report.sessions.find((s) => s.meetingId === rec.id);
    if (r !== undefined) {
      const credentials = r.credentials !== undefined && r.credentials.guildId === guildId && r.credentials.channelId === channelId ? r.credentials : prior?.credentials;
      const roster = mergeRoster(prior?.roster ?? prior?.members, r.members);
      session = {
        ...(credentials !== undefined ? { credentials } : {}),
        ...(r.members !== undefined ? { members: r.members } : prior?.members !== undefined ? { members: prior.members } : {}),
        ...(roster.length > 0 ? { roster } : {}),
        ...(r.failed !== undefined ? { failed: r.failed } : prior?.failed !== undefined ? { failed: prior.failed } : {}),
        at: now,
      };
      await putVoiceSession(org, rec.id, session, ttl);
    }
    if (session?.failed !== undefined) continue;
    voice.push({ meetingId: rec.id, guildId, channelId, deadlineMs: rec.box.createdAt + rec.box.maxMinutes * 60_000 });
  }
  const ready = policy.enabled && policy.hosts.some((h) => h.platform === "discord");
  return { voice, nextPollMs: voice.length > 0 ? VOICE_SYNC_ACTIVE_MS : ready ? VOICE_SYNC_READY_MS : VOICE_SYNC_IDLE_MS };
}
