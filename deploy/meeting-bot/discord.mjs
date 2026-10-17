import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EndBehaviorType, VoiceConnectionStatus, entersState, joinVoiceChannel } from "@discordjs/voice";
import OpusScript from "opusscript";
import { createCallback } from "./callback.js";
import { createVoiceCapture, createVoiceDirectory, wavFile } from "./discord-voice.js";

const env = (name, fallback) => {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    console.error(`[oe-meeting-bot] missing ${name}`);
    process.exit(2);
  }
  return v;
};

const CALLBACK = env("OE_MEETING_CALLBACK");
const SECRET = env("OE_MEETING_SECRET");
delete process.env.OE_MEETING_SECRET;
const CHILD_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "OE_MEETING_SECRET"));
const DEADLINE_MS = Number(env("OE_MEETING_DEADLINE_MS", String(Date.now() + 117 * 60_000)));
const ALONE_MINUTES = Number(env("OE_MEETING_ALONE_MINUTES", "5"));
const TRANSCRIBE = env("OE_MEETING_TRANSCRIBE", "gateway");
const STT_CMD = process.env.OE_MEETING_STT_CMD ?? "";
const CREDENTIALS_WAIT_MS = 2 * 60_000;
const RECONNECT_MS = 60_000;
const MAX_CHUNKS = 2_000;

const send = createCallback(CALLBACK, SECRET);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function transcribeInBox(wav) {
  if (STT_CMD === "") throw new Error("the box transcription route needs OE_MEETING_STT_CMD in the bot image");
  const file = join(mkdtempSync(join(tmpdir(), "oe-chunk-")), "chunk.wav");
  writeFileSync(file, wav);
  return await new Promise((resolve, reject) => {
    execFile(STT_CMD, [file], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 120_000, env: CHILD_ENV }, (err, stdout) => (err ? reject(err) : resolve(stdout.trim())));
  });
}

let queue = Promise.resolve();
let seq = 0;
function sendChunk(chunk) {
  if (seq >= MAX_CHUNKS) {
    console.error("[oe-meeting-bot] chunk limit reached; later speech is not sent");
    return;
  }
  const n = seq++;
  const wav = wavFile(chunk.samples);
  const who = { speaker: chunk.userId, atMs: Math.round(chunk.atMs) };
  queue = queue.then(async () => {
    if (TRANSCRIBE === "box") {
      try {
        await send({ type: "chunk", seq: n, text: await transcribeInBox(wav), ...who });
      } catch (err) {
        console.error(`[oe-meeting-bot] in-box transcription of chunk ${n} failed: ${String(err)}`);
      }
      return;
    }
    await send({ type: "chunk", seq: n, audio: { mediaType: "audio/wav", base64: wav.toString("base64") }, ...who });
  });
}

async function awaitCredentials() {
  const until = Date.now() + CREDENTIALS_WAIT_MS;
  while (Date.now() < until) {
    const { body } = await send({ type: "voice" });
    if (body?.ended === true) return { ended: true };
    if (typeof body?.failed === "string") return { failed: body.failed };
    if (body?.credentials !== undefined) return { credentials: body.credentials };
    await sleep(3_000);
  }
  return { failed: "voice-credentials-missing" };
}

let connection;
let capture;
let ending;
function finish(reason) {
  ending ??= (async () => {
    capture?.flushAll();
    await Promise.race([queue.catch(() => {}), sleep(60_000)]);
    await send({ type: "ended", chunks: seq, reason });
    try {
      connection?.destroy();
    } catch {
    }
  })();
  return ending;
}

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    void finish("terminated").finally(() => process.exit(0));
  });
}

async function main() {
  const got = await awaitCredentials();
  if (got.ended) return await finish("meeting-ended");
  if (got.credentials === undefined) {
    const detail = /^[a-z][a-z0-9-]{0,39}$/.test(got.failed) ? got.failed : "voice-join-failed";
    await send({ type: "status", state: "failed", detail });
    return await finish("failed");
  }
  const c = got.credentials;
  const directory = createVoiceDirectory();
  let adapter;
  connection = joinVoiceChannel({
    guildId: c.guildId,
    channelId: c.channelId,
    selfDeaf: false,
    selfMute: true,
    adapterCreator: (methods) => {
      adapter = methods;
      setImmediate(() => {
        methods.onVoiceStateUpdate({ guild_id: c.guildId, channel_id: c.channelId, user_id: c.userId, session_id: c.sessionId, deaf: false, mute: false, self_deaf: false, self_mute: true, self_video: false, suppress: false, request_to_speak_timestamp: null });
        methods.onVoiceServerUpdate({ guild_id: c.guildId, token: c.token, endpoint: c.endpoint });
      });
      return { sendPayload: () => true, destroy: () => {} };
    },
  });
  const receiver = connection.receiver;
  const libraryHandler = receiver.onWsPacket;
  receiver.onWsPacket = (packet) => {
    directory.onPacket(packet);
    libraryHandler(packet);
  };
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
  } catch {
    await send({ type: "status", state: "failed", detail: "voice-connect-failed" });
    return await finish("failed");
  }
  const admitted = await send({ type: "status", state: "admitted" });
  if (!admitted.ok || admitted.body?.ended === true) return await finish("notice-failed");

  const opus = new OpusScript(48_000, 2);
  capture = createVoiceCapture({
    subscribe(userId) {
      const stream = receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: 1_000 } });
      stream.on("data", (frame) => capture.frame(userId, frame));
      stream.once("end", () => capture.streamEnd(userId));
      stream.once("error", () => capture.streamEnd(userId));
    },
    decode: (frame) => new Int16Array(Uint8Array.from(opus.decode(frame)).buffer),
    onChunk: sendChunk,
  });
  receiver.speaking.on("start", (userId) => {
    if (userId !== c.userId) capture.speakingStart(userId);
  });

  let reason = "ended";
  let aloneSince;
  let lostSince;
  for (let tick = 1; ; tick++) {
    await sleep(10_000);
    if (Date.now() > DEADLINE_MS) {
      reason = "cap";
      break;
    }
    const status = connection.state.status;
    if (status === VoiceConnectionStatus.Destroyed) {
      reason = "voice-lost";
      break;
    }
    if (status !== VoiceConnectionStatus.Ready) {
      lostSince ??= Date.now();
      if (Date.now() - lostSince > RECONNECT_MS) {
        reason = "voice-lost";
        break;
      }
      const { body } = await send({ type: "voice" });
      const next = body?.credentials;
      if (next !== undefined && (next.endpoint !== c.endpoint || next.token !== c.token || next.sessionId !== c.sessionId)) {
        if (next.sessionId !== c.sessionId) {
          c.sessionId = next.sessionId;
          adapter?.onVoiceStateUpdate({ guild_id: c.guildId, channel_id: c.channelId, user_id: c.userId, session_id: c.sessionId, deaf: false, mute: false, self_deaf: false, self_mute: true, self_video: false, suppress: false, request_to_speak_timestamp: null });
        }
        c.endpoint = next.endpoint;
        c.token = next.token;
        adapter?.onVoiceServerUpdate({ guild_id: c.guildId, token: c.token, endpoint: c.endpoint });
      }
    } else {
      lostSince = undefined;
    }
    if (tick % 3 !== 0) continue;
    const { body } = await send({ type: "voice" });
    if (body?.ended === true) {
      reason = "meeting-ended";
      break;
    }
    const others = directory.others(c.userId) ?? (typeof body?.others === "number" ? body.others : undefined);
    if (others === 0) {
      aloneSince ??= Date.now();
      if (Date.now() - aloneSince > ALONE_MINUTES * 60_000) {
        reason = "alone";
        break;
      }
    } else {
      aloneSince = undefined;
    }
  }
  console.error(`[oe-meeting-bot] leaving (${reason}); dropped ${capture.stats.dropped} leaked DAVE frames, ${capture.stats.undecodable} undecodable`);
  await finish(reason);
}

try {
  await main();
} catch (err) {
  console.error(`[oe-meeting-bot] failed: ${err instanceof Error ? err.name : "error"}`);
  if (ending === undefined) await send({ type: "status", state: "failed", detail: "voice-error" });
  await finish("failed");
}
process.exit(0);
