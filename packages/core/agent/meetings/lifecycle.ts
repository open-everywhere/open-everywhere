import { createHash, randomBytes } from "node:crypto";
import { appendAudit } from "../audit/audit.js";
import { appendUsageEvent } from "../spend/usage-events.js";
import { recordSpend } from "../spend/store.js";
import { periodOf } from "../spend/spend.js";
import { sandboxGiBHourUsd } from "../spend/sandbox-pricing.js";
import { domainKeyOf } from "../memory/partition.js";
import { postSurfaceTextStrict } from "../channels/surface-message-ops.js";
import { mintStandardWebhookSecret, standardWebhookVerifier } from "../webhooks/oe-standard-webhook.js";
import { resolveHalt, haltScopeFor } from "../access/halt.js";
import { boxIsLive, boxSeconds, boxesPastCap, clampBoxMinutes, resolveLongLivedBoxBackend, registeredLongLivedBoxBackend, type BoxListing, type BoxSpec, type LongLivedBoxBackend } from "../sandbox/long-lived-box.js";
import { meetingPolicy, type MeetingPolicy } from "./policy.js";
import { meetingCompletion, transcriptionRoute } from "./transcription.js";
import { neutraliseMentions, parseRecap, recapPrompt, renderRecapPost } from "./recap.js";
import { contextTail, labelSegments, parseAttendees, parseSpeakerSpans, renderChunkText, transcriptionContext, usableSegments, type SpeakerSpan } from "./speakers.js";
import { discordRoom } from "./discord-voice.js";
import { SNOWFLAKE } from "./link.js";
import {
  MAX_OPEN_MEETINGS,
  deleteMeetingRecord,
  releaseMeetingOpen,
  chunkCount,
  claimMeetingOpen,
  claimOpenMeetingSlot,
  openMeetingSlots,
  raiseChunkHighWater,
  releaseOpenMeetingSlot,
  claimMeetingBilling,
  claimMeetingRecap,
  getMeetingRecord,
  getMeetingRow,
  putMeetingRow,
  putMeetingRowIfAbsent,
  putMeetingRecord,
  putTranscriptChunk,
  readTranscript,
  readTranscriptChunk,
  getVoiceSession,
  deleteVoiceSession,
  claimDiscordGuild,
  releaseDiscordGuild,
  recordTtlMs,
  type MeetingRecord,
  type MeetingStatus,
} from "./store.js";
import type { MeetingPlatform } from "./link.js";
import { markMeetingPostTarget, markPostedRecap } from "./provenance.js";
import type { Partition } from "../memory/partition.js";
import type { SurfaceMode } from "../operational/store.js";

export const MEETING_CALLBACK_PATH = "/meetings/v1";
export const MAX_CALLBACK_BYTES = 4 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface MeetingJoinArgs {
  readonly org: string;
  readonly scopeKey: string;
  readonly meetingId: string;
  readonly url: string;
  readonly platform: MeetingPlatform;
  readonly host: string;
  readonly roomId: string;
  readonly channelLabel?: string;
  readonly serverLabel?: string;
  readonly requestedBy: string;
  readonly origin: { readonly platform: string; readonly channelId: string; readonly threadTs: string | null };
  readonly partition: Partition;
  readonly surfaceMode?: SurfaceMode;
  readonly maxMinutes: number;
  readonly transcriptDays: number;
  readonly transcriptionDisclosure: string;
  readonly backend: string;
  readonly reason?: string;
}

export function mintMeetingId(turn?: { readonly sessionId: string; readonly turnId: string; readonly url: string }): string {
  if (turn === undefined) return `mtg_${randomBytes(16).toString("hex").slice(0, 26)}`;
  return `mtg_${createHash("sha256").update(`${turn.sessionId}\n${turn.turnId}\n${turn.url}`).digest("hex").slice(0, 26)}`;
}

function auditWhere(p: Partition): { org: string; platform: string; workspace: string; surface: string } {
  return { org: p.org, platform: p.platform, workspace: p.workspace, surface: p.surface };
}

export const BOT_DEADLINE_MARGIN_MINUTES = 3;

export function meetingBoxSpec(args: MeetingJoinArgs, policy: MeetingPolicy, callbackBase: string, secret: string, now: number = Date.now()): BoxSpec {
  const cap = Math.min(args.maxMinutes, policy.maxMinutes);
  return {
    purpose: "meeting",
    ref: args.meetingId,
    image: policy.box.image,
    command: ["node", args.platform === "discord" ? "/opt/oe-meeting-bot/discord.mjs" : "/opt/oe-meeting-bot/bot.mjs"],
    vcpus: policy.box.vcpus,
    memoryMb: policy.box.memoryMb,
    shmMb: 1024,
    user: "pwuser",
    maxMinutes: cap,
    egress: "open",
    env: {
      OE_MEETING_ID: args.meetingId,
      OE_MEETING_URL: args.url,
      OE_MEETING_PLATFORM: args.platform,
      OE_MEETING_BOT_NAME: policy.botName,
      OE_MEETING_CALLBACK: `${callbackBase.replace(/\/+$/, "")}${MEETING_CALLBACK_PATH}/${args.meetingId}`,
      OE_MEETING_SECRET: secret,
      OE_MEETING_DEADLINE_MS: String(now + Math.max(1, cap - BOT_DEADLINE_MARGIN_MINUTES) * 60_000),
      OE_MEETING_ALONE_MINUTES: String(policy.leaveWhenAloneMinutes),
      OE_MEETING_TRANSCRIBE: policy.transcription.route,
    },
  };
}

async function findMeetingBox(backend: LongLivedBoxBackend, ref: string): Promise<BoxListing | undefined> {
  try {
    for (const box of await backend.list("meeting")) {
      const r = box.ref ?? (await backend.status(box.name))?.ref;
      if (r === ref && boxIsLive(box.status)) return box;
    }
  } catch {
  }
  return undefined;
}

export interface OpenMeetingDeps {
  readonly backend?: LongLivedBoxBackend;
  readonly policy?: MeetingPolicy;
  readonly callbackBase?: string;
  readonly now?: () => number;
}

export async function openMeeting(args: MeetingJoinArgs, approvedBy: string, deps: OpenMeetingDeps = {}): Promise<MeetingRecord> {
  const policy = deps.policy ?? meetingPolicy();
  if (!policy.enabled) throw new Error("meetings were turned off on this deployment after the card was posted, so I did not join");
  if (deps.callbackBase === undefined) throw new Error("this deployment has no public URL for the meeting bot to call back on (OE_PUBLIC_BASE_URL, or a Vercel production URL), so I did not join");
  const backend = deps.backend ?? resolveLongLivedBoxBackend();
  const now = deps.now ?? Date.now;
  const cap = clampBoxMinutes(Math.min(args.maxMinutes, policy.maxMinutes), backend.maxMinutesCeiling);
  const ttl = recordTtlMs(cap, policy.retention.transcriptDays);
  if (!(await claimMeetingOpen(args.org, args.meetingId, ttl))) {
    const existing = await getMeetingRecord(args.org, args.meetingId);
    if (existing !== undefined && existing.box.name !== "") {
      await auditJoinOnce(existing, policy, true);
      return existing;
    }
    if (existing !== undefined) {
      const found = await findMeetingBox(backend, args.meetingId);
      if (found !== undefined) {
        const filled: MeetingRecord = { ...existing, box: { ...existing.box, name: found.name, createdAt: found.createdAt } };
        await putMeetingRecord(filled, ttl);
        await auditJoinOnce(filled, policy, true);
        return filled;
      }
    }
    throw new Error("this meeting bot is already being sent, so I did not send a second one");
  }
  const room = discordRoom(args);
  if (room !== undefined && !(await claimDiscordGuild(args.org, room.guildId, args.meetingId, ttl, now()))) {
    await releaseMeetingOpen(args.org, args.meetingId);
    throw new Error("the meeting bot is already recording a voice channel on this Discord server, and Discord allows it in one voice channel per server — so I did not send it");
  }
  const slot = await claimOpenMeetingSlot(args.org, args.meetingId, ttl, now());
  if (slot === undefined) {
    if (room !== undefined) await releaseDiscordGuild(args.org, room.guildId, args.meetingId);
    await releaseMeetingOpen(args.org, args.meetingId);
    throw new Error(`this deployment already has ${MAX_OPEN_MEETINGS} meeting bots running, so I did not send another`);
  }
  const secret = mintStandardWebhookSecret();
  const provisional: MeetingRecord = {
    id: args.meetingId,
    org: args.org,
    platform: args.platform,
    host: args.host,
    roomId: args.roomId,
    ...(args.channelLabel !== undefined ? { channelLabel: args.channelLabel } : {}),
    ...(args.serverLabel !== undefined ? { serverLabel: args.serverLabel } : {}),
    requestedBy: args.requestedBy,
    approvedBy,
    origin: args.origin,
    partition: args.partition,
    secret,
    box: { name: "", backend: backend.backend, metered: backend.metered, createdAt: now(), maxMinutes: cap, memoryMb: policy.box.memoryMb },
    slot,
    status: "joining",
    createdAt: new Date(now()).toISOString(),
  };
  await putMeetingRecord(provisional, ttl);
  const spec = meetingBoxSpec(args, policy, deps.callbackBase, secret, now());
  let opened;
  try {
    opened = await backend.open(spec);
  } catch (err) {
    await deleteMeetingRecord(args.org, args.meetingId);
    await releaseOpenMeetingSlot(args.org, slot, args.meetingId);
    if (room !== undefined) await releaseDiscordGuild(args.org, room.guildId, args.meetingId);
    await releaseMeetingOpen(args.org, args.meetingId);
    throw err;
  }
  const rec: MeetingRecord = {
    ...provisional,
    box: { name: opened.name, backend: opened.backend, metered: backend.metered, createdAt: opened.createdAt, maxMinutes: opened.maxMinutes, memoryMb: policy.box.memoryMb },
  };
  await putMeetingRecord(rec, recordTtlMs(opened.maxMinutes, policy.retention.transcriptDays));
  await auditJoinOnce(rec, policy, false);
  return rec;
}

async function auditJoinOnce(rec: MeetingRecord, policy: MeetingPolicy, replay: boolean): Promise<void> {
  const marker = `meeting-join-audited:${rec.id}`;
  if ((await getMeetingRow(rec.org, marker)) !== null) return;
  await appendAudit({
    ...auditWhere(rec.partition),
    principalId: rec.approvedBy,
    action: "meeting.join",
    detail: {
      meetingId: rec.id,
      platform: rec.platform,
      host: rec.host,
      roomId: rec.roomId,
      requestedBy: rec.requestedBy,
      backend: rec.box.backend,
      box: rec.box.name,
      maxMinutes: rec.box.maxMinutes,
      transcription: policy.transcription.route,
      ...(replay ? { replay: true } : {}),
    },
  });
  await putMeetingRow(rec.org, marker, "1", recordTtlMs(rec.box.maxMinutes, policy.retention.transcriptDays));
}

export type MeetingEvent =
  | { readonly type: "status"; readonly state: "lobby" | "admitted" | "refused" | "failed"; readonly detail?: string }
  | {
      readonly type: "chunk";
      readonly seq: number;
      readonly audio?: { readonly mediaType: string; readonly base64: string };
      readonly text?: string;
      readonly speakers?: readonly SpeakerSpan[];
      readonly attendees?: readonly string[];
      readonly speaker?: string;
      readonly atMs?: number;
    }
  | { readonly type: "voice" }
  | { readonly type: "ended"; readonly chunks: number; readonly reason: string };

const STATES = new Set(["lobby", "admitted", "refused", "failed"]);

export const MAX_MEETING_CHUNKS = 2_000;

export function parseMeetingEvent(raw: string): MeetingEvent | { readonly error: string } {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return { error: "body is not JSON" };
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) return { error: "body is not an object" };
  const o = v as Record<string, unknown>;
  if (o.type === "status") {
    if (typeof o.state !== "string" || !STATES.has(o.state)) return { error: "status.state is not a known state" };
    return { type: "status", state: o.state as "lobby", ...(typeof o.detail === "string" && /^[a-z][a-z0-9-]{0,39}$/.test(o.detail) ? { detail: o.detail } : {}) };
  }
  if (o.type === "chunk") {
    if (typeof o.seq !== "number" || !Number.isInteger(o.seq) || o.seq < 0 || o.seq >= MAX_MEETING_CHUNKS) return { error: `chunk.seq must be an integer from 0 to ${MAX_MEETING_CHUNKS - 1}` };
    const a = o.audio as Record<string, unknown> | undefined;
    const audio = a !== undefined && a !== null && typeof a.mediaType === "string" && typeof a.base64 === "string" ? { mediaType: a.mediaType, base64: a.base64 } : undefined;
    const text = typeof o.text === "string" ? o.text : undefined;
    if ((audio === undefined) === (text === undefined)) return { error: "a chunk carries exactly one of audio or text" };
    if (audio !== undefined && !/^audio\/[a-z0-9.+-]+(;.*)?$/.test(audio.mediaType)) return { error: "chunk.audio.mediaType must be an audio type" };
    const speakers = parseSpeakerSpans(o.speakers);
    const attendees = parseAttendees(o.attendees);
    const speaker = typeof o.speaker === "string" && SNOWFLAKE.test(o.speaker) ? o.speaker : undefined;
    const atMs = typeof o.atMs === "number" && Number.isFinite(o.atMs) && o.atMs >= 0 && o.atMs <= 25 * 60 * 60_000 ? Math.round(o.atMs) : undefined;
    return {
      type: "chunk",
      seq: o.seq,
      ...(audio !== undefined ? { audio } : {}),
      ...(text !== undefined ? { text } : {}),
      ...(speakers !== undefined && speakers.length > 0 ? { speakers } : {}),
      ...(attendees !== undefined && attendees.length > 0 ? { attendees } : {}),
      ...(speaker !== undefined ? { speaker } : {}),
      ...(atMs !== undefined ? { atMs } : {}),
    };
  }
  if (o.type === "voice") return { type: "voice" };
  if (o.type === "ended") {
    if (typeof o.chunks !== "number" || !Number.isInteger(o.chunks) || o.chunks < 0 || o.chunks > MAX_MEETING_CHUNKS) return { error: "ended.chunks must be an integer" };
    return { type: "ended", chunks: o.chunks, reason: typeof o.reason === "string" ? o.reason.slice(0, 40) : "ended" };
  }
  return { error: "unknown event type" };
}

export interface CallbackResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

export interface CallbackDeps extends FinishDeps {
  readonly nowMs?: number;
  readonly defer?: (work: Promise<unknown>) => void;
}

export async function handleMeetingCallback(org: string, meetingId: string, rawBody: string, headers: Headers, deps: CallbackDeps = {}): Promise<CallbackResult> {
  if (rawBody.length > MAX_CALLBACK_BYTES) return { status: 413, body: { ok: false } };
  const rec = await getMeetingRecord(org, meetingId);
  if (rec === undefined) return { status: 401, body: { ok: false } };
  const verdict = await standardWebhookVerifier.verify({ rawBody, headers, keys: [rec.secret], nowMs: deps.nowMs ?? Date.now() });
  if (!verdict.ok) return { status: 401, body: { ok: false } };
  const policy = deps.policy ?? meetingPolicy();
  const ttl = policy.retention.transcriptDays * DAY_MS;
  const replayKey = verdict.replayKey ?? "";
  const first = await putMeetingRowIfAbsent(org, `meeting-msg:${meetingId}:${replayKey}`, "1", ttl);
  if (!first) return { status: 200, body: { ok: true, duplicate: true } };
  const event = parseMeetingEvent(rawBody);
  if ("error" in event) return { status: 400, body: { ok: false, error: event.error } };

  if (event.type === "status") {
    if (rec.status === "ended" || rec.status === "recapped") return { status: 200, body: { ok: true } };
    const wasAdmitted = rec.status === "admitted";
    const status: MeetingStatus = event.state === "admitted" ? "admitted" : event.state === "lobby" ? "lobby" : wasAdmitted ? "admitted" : "failed";
    if (rec.platform === "discord" && event.state === "admitted" && !wasAdmitted && !(await notifyVoiceChannel(rec, DISCORD_RECORDING_NOTICE, deps))) {
      const failed: MeetingRecord = { ...rec, status: "failed" };
      await putMeetingRecord(failed, recordTtlMs(rec.box.maxMinutes, policy.retention.transcriptDays));
      await appendAudit({ ...auditWhere(rec.partition), principalId: rec.requestedBy, action: "meeting.status", detail: { meetingId, state: "failed", detail: "notice-failed" } });
      await notifyThread(rec, "I could not post the recording notice in the Discord voice channel, so the meeting bot left without recording. Give it Send Messages in that channel and ask again.", deps);
      await finishMeeting(failed, "notice-failed", deps);
      return { status: 200, body: { ok: true, ended: true } };
    }
    await putMeetingRecord({ ...rec, status }, recordTtlMs(rec.box.maxMinutes, policy.retention.transcriptDays));
    await appendAudit({ ...auditWhere(rec.partition), principalId: rec.requestedBy, action: "meeting.status", detail: { meetingId, state: event.state, ...(event.detail ? { detail: event.detail } : {}) } });
    if (!wasAdmitted && (event.state === "refused" || event.state === "failed")) {
      await notifyThread(rec, event.state === "refused" ? "The meeting bot was not admitted, so there will be no recap." : "The meeting bot could not join the meeting, so there will be no recap.", deps);
    }
    return { status: 200, body: { ok: true } };
  }

  if (event.type === "voice") {
    if (rec.platform !== "discord") return { status: 400, body: { ok: false, error: "voice is for Discord meetings" } };
    if (rec.status === "ended" || rec.status === "recapped") return { status: 200, body: { ok: true, ended: true } };
    const session = await getVoiceSession(org, meetingId);
    return {
      status: 200,
      body: {
        ok: true,
        ...(session?.credentials !== undefined ? { credentials: session.credentials } : {}),
        ...(session?.failed !== undefined ? { failed: session.failed } : {}),
        ...(session?.members !== undefined ? { others: session.members.filter((m) => m.id !== session.credentials?.userId).length } : {}),
      },
    };
  }

  if (event.type === "chunk") {
    if (rec.status === "ended" || rec.status === "recapped") return { status: 200, body: { ok: true, ended: true } };
    if (await (deps.halted ?? meetingHalted)(rec)) {
      await finishMeeting(rec, "halted", deps);
      return { status: 200, body: { ok: true, halted: true } };
    }
    const route = transcriptionRoute(policy.transcription.route);
    if (route === undefined) return { status: 503, body: { ok: false, error: "transcription route unavailable" } };
    const input = event.audio !== undefined
      ? ({ kind: "audio", mediaType: event.audio.mediaType, data: Buffer.from(event.audio.base64, "base64") } as const)
      : ({ kind: "text", text: event.text ?? "" } as const);
    const previous = await readTranscriptChunk(org, meetingId, event.seq - 1);
    const session = rec.platform === "discord" ? await getVoiceSession(org, meetingId) : undefined;
    const members = session?.roster ?? session?.members ?? [];
    const attendees = rec.platform === "discord" ? members.map((m) => m.name) : (event.attendees ?? previous?.attendees ?? []);
    const prompt = transcriptionContext({ ...(previous?.tail !== undefined ? { previousTail: previous.tail } : {}), attendees });
    let result: Awaited<ReturnType<typeof route.transcribe>>;
    try {
      result = await route.transcribe(input, {
        ...(policy.transcription.model !== undefined ? { model: policy.transcription.model } : {}),
        scope: rec.partition.surfaceKey,
        ...(prompt !== undefined ? { prompt } : {}),
      });
    } catch (err) {
      console.warn(`[open-everywhere:meetings] transcription of chunk ${event.seq} failed for ${meetingId}: ${String(err)}`);
      return { status: 502, body: { ok: false, error: "transcription failed" } };
    }
    const plain = typeof result === "string" ? result : result.text;
    const segments = typeof result === "string" ? [] : usableSegments(plain, result.segments);
    const speakerName = event.speaker !== undefined ? members.find((m) => m.id === event.speaker)?.name : undefined;
    const lines = speakerName !== undefined && plain.trim().length > 0
      ? [{ speaker: speakerName, text: plain.trim() }]
      : segments.length > 0 && event.speakers !== undefined ? labelSegments(segments, event.speakers) : [];
    const chunk = renderChunkText(plain, lines);
    await putTranscriptChunk(org, meetingId, event.seq, { text: chunk.text, tail: contextTail(plain), ...(attendees.length > 0 ? { attendees } : {}), labelled: chunk.labelled, ...(event.atMs !== undefined ? { atMs: event.atMs } : {}) }, ttl);
    await raiseChunkHighWater(org, meetingId, event.seq, ttl);
    return { status: 200, body: { ok: true } };
  }

  if (rec.status === "ended" || rec.status === "recapped") return { status: 200, body: { ok: true, duplicate: true } };
  const finishing = finishMeeting({ ...rec, chunks: event.chunks }, event.reason, deps).catch((err: unknown) => {
    console.warn(`[open-everywhere:meetings] finishing ${meetingId} failed (the sweep retries the stop): ${String(err)}`);
  });
  if (deps.defer !== undefined) deps.defer(finishing);
  else await finishing;
  return { status: 200, body: { ok: true } };
}

export interface FinishDeps {
  readonly backend?: LongLivedBoxBackend;
  readonly policy?: MeetingPolicy;
  readonly now?: () => number;
  readonly post?: (platform: string, target: { channelId: string; text: string; threadTs?: string | null; replyToMessageId?: string }) => Promise<string>;
  readonly halted?: (rec: MeetingRecord) => Promise<boolean>;
}

export async function meetingHalted(rec: MeetingRecord): Promise<boolean> {
  const state = await resolveHalt(haltScopeFor({ org: rec.org, scopeKey: rec.partition.surfaceKey, principalId: rec.requestedBy }));
  return state.halted;
}

export async function notifyThread(rec: Pick<MeetingRecord, "id" | "origin">, text: string, deps: Pick<FinishDeps, "post">): Promise<string | undefined> {
  try {
    const thread = rec.origin.threadTs;
    return await (deps.post ?? postSurfaceTextStrict)(rec.origin.platform, {
      channelId: rec.origin.channelId,
      threadTs: thread,
      text,
      ...(rec.origin.platform !== "slack" && thread ? { replyToMessageId: thread } : {}),
    });
  } catch (err) {
    console.warn(`[open-everywhere:meetings] thread post failed for ${rec.id}: ${String(err)}`);
    return undefined;
  }
}

export const DISCORD_RECORDING_NOTICE =
  "🔴 Recording: OE's meeting notetaker is in this voice channel and records each speaker for a written recap. The recap goes to the thread that asked for it. Audio is not stored. To stop it, ask OE to leave the meeting in that thread.";
export const DISCORD_STOPPED_NOTICE = "⏹️ OE's meeting notetaker left this voice channel and stopped recording.";

async function notifyVoiceChannel(rec: MeetingRecord, text: string, deps: FinishDeps): Promise<boolean> {
  const room = discordRoom(rec);
  if (room === undefined) return false;
  try {
    await (deps.post ?? postSurfaceTextStrict)("discord", { channelId: room.channelId, text });
    return true;
  } catch (err) {
    console.warn(`[open-everywhere:meetings] voice channel notice failed for ${rec.id}: ${String(err)}`);
    return false;
  }
}

export function meetingBoxUsd(seconds: number, memoryMb: number, metered: boolean): number {
  if (!metered) return 0;
  return (Math.max(0, seconds) / 3600) * (memoryMb / 1024) * sandboxGiBHourUsd();
}

export async function billMeetingHours(rec: MeetingRecord, endedAt: number, policy: MeetingPolicy): Promise<{ readonly seconds: number; readonly usd: number } | undefined> {
  if (!(await claimMeetingBilling(rec.org, rec.id, recordTtlMs(rec.box.maxMinutes, policy.retention.transcriptDays)))) return undefined;
  const seconds = Math.min(boxSeconds(rec.box.createdAt, endedAt), rec.box.maxMinutes * 60 + 300);
  const usd = meetingBoxUsd(seconds, rec.box.memoryMb, rec.box.metered);
  const p = rec.partition;
  try {
    await recordSpend(p, { period: periodOf(new Date(endedAt).toISOString()), usage: {}, principalId: rec.requestedBy, model: "", usdMicros: Math.round(usd * 1_000_000) });
  } catch (err) {
    console.warn(`[open-everywhere:meetings] spend-ledger row failed for ${rec.id}: ${String(err)}`);
  }
  try {
    await appendUsageEvent({
      org: p.org,
      surfaceKey: domainKeyOf(p),
      sessionId: `meeting:${rec.id}`,
      kind: "meeting",
      principalId: rec.requestedBy,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      detail: { meetingSeconds: seconds, meetingHours: Math.round((seconds / 3600) * 1000) / 1000, box: rec.box.name, backend: rec.box.backend, metered: rec.box.metered },
    });
  } catch (err) {
    console.warn(`[open-everywhere:meetings] usage event failed for ${rec.id}: ${String(err)}`);
  }
  return { seconds, usd };
}

export async function finishMeeting(
  rec: MeetingRecord,
  reason: string,
  deps: FinishDeps = {},
  opts: { readonly stoppedBy?: string } = {},
): Promise<{ readonly posted: boolean; readonly billed: boolean }> {
  const policy = deps.policy ?? meetingPolicy();
  if (reason !== "halted" && (await (deps.halted ?? meetingHalted)(rec))) reason = "halted";
  const now = (deps.now ?? Date.now)();
  const backend = deps.backend ?? registeredLongLivedBoxBackend();
  try {
    await backend?.stop(rec.box.name);
  } catch (err) {
    console.warn(`[open-everywhere:meetings] box stop failed for ${rec.id} (its cap still stops it): ${String(err)}`);
  }
  const bill = await billMeetingHours(rec, now, policy);
  const ttl = recordTtlMs(rec.box.maxMinutes, policy.retention.transcriptDays);
  await putMeetingRecord({ ...rec, status: "ended", endedAt: new Date(now).toISOString() }, ttl);
  await releaseOpenMeetingSlot(rec.org, rec.slot, rec.id);
  const room = discordRoom(rec);
  if (room !== undefined) {
    await deleteVoiceSession(rec.org, rec.id);
    await releaseDiscordGuild(rec.org, room.guildId, rec.id);
  }
  await appendAudit({
    ...auditWhere(rec.partition),
    principalId: rec.requestedBy,
    action: "meeting.ended",
    detail: {
      meetingId: rec.id,
      reason,
      box: rec.box.name,
      ...(opts.stoppedBy !== undefined ? { stoppedBy: opts.stoppedBy } : {}),
      ...(bill !== undefined ? { seconds: bill.seconds, usdMicros: Math.round(bill.usd * 1_000_000) } : {}),
    },
  });
  if (rec.status === "admitted" && reason !== "halted") await notifyVoiceChannel(rec, DISCORD_STOPPED_NOTICE, deps);
  if (reason === "halted") {
    await claimMeetingRecap(rec.org, rec.id, ttl);
    return { posted: false, billed: bill !== undefined };
  }
  if (rec.status === "failed" || reason === "refused") return { posted: false, billed: bill !== undefined };
  await markMeetingPostTarget(rec.org, rec.origin);
  if (!(await claimMeetingRecap(rec.org, rec.id, ttl))) return { posted: false, billed: bill !== undefined };
  const minutes = Math.max(1, Math.round(boxSeconds(rec.box.createdAt, now) / 60));
  const { text, missing, attendees, labelled } = await readTranscript(rec.org, rec.id, await chunkCount(rec.org, rec.id, rec.chunks));
  const empty = text.trim().length === 0;
  let recap = undefined;
  if (!empty) {
    const complete = meetingCompletion();
    if (complete !== undefined) {
      try {
        recap = parseRecap(await complete(rec.partition.surfaceKey, recapPrompt(text, { platform: rec.platform, minutes, attendees, labelled: labelled > 0, ...(rec.platform === "discord" ? { labelSource: "voice" as const } : {}) })));
      } catch (err) {
        console.warn(`[open-everywhere:meetings] recap completion failed for ${rec.id}: ${String(err)}`);
      }
    }
  }
  const roomName = rec.channelLabel !== undefined ? neutraliseMentions(rec.channelLabel.replace(/^#/, "")) : "";
  const post = renderRecapPost(recap, { platform: rec.platform, minutes, missingChunks: missing.length, empty, ...(roomName.length > 0 ? { room: roomName } : {}) });
  const messageId = await notifyThread(rec, post, deps);
  if (messageId !== undefined) await markPostedRecap(rec.org, rec.origin, messageId);
  await putMeetingRecord({ ...rec, status: "recapped", endedAt: new Date(now).toISOString() }, ttl);
  await appendAudit({
    ...auditWhere(rec.partition),
    principalId: rec.requestedBy,
    action: "meeting.recap_posted",
    detail: {
      meetingId: rec.id,
      posted: messageId !== undefined,
      decisions: recap?.decisions.length ?? 0,
      actions: recap?.actions.length ?? 0,
      summarised: recap !== undefined,
      missingChunks: missing.length,
      labelledLines: labelled,
    },
  });
  return { posted: messageId !== undefined, billed: bill !== undefined };
}

export async function openMeetingsFrom(org: string, origin: { readonly platform: string; readonly channelId: string }): Promise<MeetingRecord[]> {
  const out: MeetingRecord[] = [];
  for (const { id } of await openMeetingSlots(org)) {
    const rec = await getMeetingRecord(org, id);
    if (rec === undefined || rec.status === "ended" || rec.status === "recapped") continue;
    if (rec.origin.platform === origin.platform && rec.origin.channelId === origin.channelId) out.push(rec);
  }
  return out;
}

const SWEEP_GRACE_MINUTES = 10;
const STALE_SLOT_MINUTES = 30;

export async function sweepMeetingBoxes(org: string, deps: FinishDeps = {}): Promise<{ readonly finished: string[]; readonly stopped: string[] }> {
  const backend = deps.backend ?? registeredLongLivedBoxBackend();
  const policy = deps.policy ?? meetingPolicy();
  const now = (deps.now ?? Date.now)();
  const finished: string[] = [];
  const stopped: string[] = [];
  const known = new Set<string>();
  for (const { slot, id, at } of await openMeetingSlots(org)) {
    known.add(id);
    const rec = await getMeetingRecord(org, id);
    if (rec === undefined) {
      if (now - at > STALE_SLOT_MINUTES * 60_000) await releaseOpenMeetingSlot(org, slot, id);
      continue;
    }
    if (rec.status === "ended" || rec.status === "recapped") {
      await releaseOpenMeetingSlot(org, slot, id);
      const room = discordRoom(rec);
      if (room !== undefined) await releaseDiscordGuild(org, room.guildId, id);
      continue;
    }
    if (await (deps.halted ?? meetingHalted)(rec)) {
      await finishMeeting(rec, "halted", { ...deps, ...(backend !== undefined ? { backend } : {}), now: () => now });
      finished.push(id);
      continue;
    }
    if (now - rec.box.createdAt <= (rec.box.maxMinutes + SWEEP_GRACE_MINUTES) * 60_000) continue;
    await finishMeeting(rec, "cap", { ...deps, ...(backend !== undefined ? { backend } : {}), now: () => now });
    finished.push(id);
  }
  if (backend !== undefined && backend.unavailable === undefined && (policy.enabled || known.size > 0)) {
    try {
      for (const box of boxesPastCap(await backend.list("meeting"), policy.maxMinutes, now)) {
        const ref = box.ref ?? (await backend.status(box.name))?.ref;
        if (ref !== undefined && known.has(ref)) continue;
        await backend.stop(box.name);
        stopped.push(box.name);
      }
    } catch (err) {
      console.warn(`[open-everywhere:meetings] the orphan-box listing failed (each box still stops at its cap): ${String(err)}`);
    }
  }
  return { finished, stopped };
}
