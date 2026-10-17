export function voiceStatePayload(guildId, channelId) {
  return { op: 4, d: { guild_id: guildId, channel_id: channelId, self_mute: true, self_deaf: false } };
}

const SNOWFLAKE = /^\d{17,20}$/;

export function parseSyncAnswer(raw) {
  const voice = [];
  if (raw === null || typeof raw !== "object") return { voice, nextPollMs: undefined };
  for (const v of Array.isArray(raw.voice) ? raw.voice : []) {
    if (v === null || typeof v !== "object") continue;
    if (typeof v.meetingId !== "string" || !/^mtg_[a-z0-9]{20,40}$/.test(v.meetingId)) continue;
    if (!SNOWFLAKE.test(String(v.guildId)) || !SNOWFLAKE.test(String(v.channelId))) continue;
    if (typeof v.deadlineMs !== "number" || !Number.isFinite(v.deadlineMs)) continue;
    voice.push({ meetingId: v.meetingId, guildId: v.guildId, channelId: v.channelId, deadlineMs: v.deadlineMs });
  }
  const n = Number(raw.nextPollMs);
  return { voice, nextPollMs: Number.isFinite(n) ? n : undefined };
}

export function nextDelay(nextPollMs) {
  if (nextPollMs === undefined) return 10_000;
  return Math.min(600_000, Math.max(1_000, nextPollMs));
}

export function planVoice(desired, held, now) {
  const live = desired.filter((v) => v.deadlineMs > now);
  const wanted = new Set(live.map((v) => v.meetingId));
  const leave = [...held.keys()].filter((id) => !wanted.has(id));
  const busy = new Set([...held.entries()].filter(([id]) => wanted.has(id)).map(([, h]) => h.guildId));
  const join = [];
  for (const v of live) {
    if (held.has(v.meetingId) || busy.has(v.guildId)) continue;
    busy.add(v.guildId);
    join.push(v);
  }
  return { join, leave };
}

export function channelRefusal(channel, canConnect) {
  if (channel === undefined || channel === null) return "not-found";
  if (channel.type === 13) return "stage-channel";
  if (channel.type !== 2) return "not-voice";
  if (!canConnect) return "no-permission";
  return undefined;
}

export function credentialsFrom(state, server, expect) {
  if (!state || !server || !server.endpoint || !server.token) return undefined;
  if (state.guild_id !== expect.guildId || state.channel_id !== expect.channelId || server.guild_id !== expect.guildId) return undefined;
  if (typeof state.session_id !== "string" || typeof state.user_id !== "string") return undefined;
  return { guildId: expect.guildId, channelId: expect.channelId, userId: state.user_id, sessionId: state.session_id, token: server.token, endpoint: server.endpoint };
}

export const JOIN_TIMEOUT_MS = 30_000;

export function heldReport(h, credentials, now) {
  if (h.failed) return { failed: h.failed };
  if (credentials) {
    h.ready = true;
    return { credentials };
  }
  if (!h.ready && now - h.since > JOIN_TIMEOUT_MS) {
    h.failed = "join-timeout";
    return { failed: h.failed };
  }
  return {};
}

export function voiceSyncEnvelope(relayId, sessions) {
  return { source: "discord-gateway-relay", event: "VOICE_SYNC", voice: { relayId, sessions } };
}
