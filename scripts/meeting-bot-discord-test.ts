import { createVoiceCapture, createVoiceDirectory, isLeakedDaveFrame, OUT_RATE, RULE, toMono16k, wavFile, type VoiceChunk } from "../deploy/meeting-bot/discord-voice.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const FRAME_MS = 20;
const SAMPLES_PER_FRAME = (OUT_RATE * FRAME_MS) / 1000;
const opusFrame = (): Uint8Array => Uint8Array.from([0xfc, 0xff, 0xfe, 0x01]);
const daveLeak = (): Uint8Array => Uint8Array.from([0x90, 0x12, 0x34, 0xfa, 0xfa]);

function harness(opts: { turnCutBudget?: number } = {}) {
  let clock = 1_000_000;
  const chunks: VoiceChunk[] = [];
  const subscribed: string[] = [];
  let decoded = 0;
  const cap = createVoiceCapture({
    subscribe: (u) => subscribed.push(u),
    decode: () => {
      decoded++;
      return new Int16Array(1_920).fill(1_000);
    },
    onChunk: (c) => chunks.push(c),
    now: () => clock,
    ...(opts.turnCutBudget !== undefined ? { turnCutBudget: opts.turnCutBudget } : {}),
  });
  function speak(user: string, ms: number, end = true): void {
    cap.speakingStart(user);
    for (let t = 0; t < ms; t += FRAME_MS) {
      cap.frame(user, opusFrame());
      clock += FRAME_MS;
    }
    if (end) cap.streamEnd(user);
  }
  return { cap, chunks, subscribed, speak, advance: (ms: number) => (clock += ms), decoded: () => decoded };
}

{
  ok(isLeakedDaveFrame(daveLeak()), "a frame ending in the DAVE marker 0xFAFA is a leaked encrypted frame");
  ok(!isLeakedDaveFrame(opusFrame()), "an ordinary Opus frame is not");
  ok(!isLeakedDaveFrame(Uint8Array.from([0xfa])) && !isLeakedDaveFrame(Uint8Array.from([0x01, 0xfa])) && !isLeakedDaveFrame(Uint8Array.from([0xfa, 0x01])), "one 0xFA byte, or the marker anywhere but the end, is not");
  const h = harness();
  h.cap.speakingStart("A");
  h.cap.frame("A", daveLeak());
  h.cap.frame("A", daveLeak());
  h.cap.frame("A", opusFrame());
  ok(h.cap.stats.dropped === 2 && h.decoded() === 1, `the two leaked frames after a join are dropped before the decoder, and the good one is decoded (dropped ${h.cap.stats.dropped}, decoded ${h.decoded()})`);
  h.cap.streamEnd("A");
  h.cap.flushAll();
  ok(h.chunks.length === 1 && h.chunks[0]!.samples.length === SAMPLES_PER_FRAME, "only the good frame's audio reaches the chunk");
}

{
  const d = createVoiceDirectory();
  ok(d.others("BOT") === undefined, "before the voice gateway said anything, the member count is unknown (not zero)");
  d.onPacket({ op: 11, d: { user_ids: ["A", "BOT"] } });
  ok(d.others("BOT") === 1, "CLIENTS_CONNECT counts the members in the call, leaving out the bot");
  d.onPacket({ op: 5, d: { user_id: "B", ssrc: 202, speaking: 1 } });
  ok(d.others("BOT") === 2, "a LATE JOINER the call never announced counts once its Speaking packet (op 5) names it");
  d.onPacket({ op: 13, d: { user_id: "A" } });
  d.onPacket({ op: 13, d: { user_id: "B" } });
  ok(d.others("BOT") === 0, "members who disconnect (op 13) leave the count: the bot is alone");
  d.onPacket({ op: 5, d: { user_id: "X", ssrc: "not-a-number" } });
  d.onPacket({ op: 5 });
  ok(d.others("BOT") === 0, "a malformed packet changes nothing");
}

{
  const h = harness();
  h.cap.speakingStart("A");
  h.cap.speakingStart("A");
  ok(h.subscribed.length === 1, "a second speaking start while the stream is live does not subscribe twice");
  h.cap.frame("A", opusFrame());
  h.cap.streamEnd("A");
  h.cap.speakingStart("A");
  ok(h.subscribed.join(",") === "A,A" && h.cap.stats.subscriptions === 2, "after the stream ends at a silence, the next speaking start subscribes AGAIN");
  h.cap.frame("A", opusFrame());
  h.cap.streamEnd("A");
  h.cap.flushAll();
  const gap = Math.round((RULE.gapMs / 1000) * OUT_RATE);
  ok(h.chunks.length === 1 && h.chunks[0]!.samples.length === 2 * SAMPLES_PER_FRAME + gap, "both streams' audio lands in one chunk, with a short silence between the two utterances");
}

{
  const h = harness();
  h.speak("A", 5_000);
  h.advance(1_000);
  h.speak("B", 4_000);
  h.advance(1_000);
  h.speak("A", 2_000);
  h.cap.flushAll();
  const order = h.chunks.map((c) => `${c.userId}@${c.atMs}:${c.reason}`).join(" ");
  ok(order === "A@0:turn B@6000:turn A@11000:end", `the chunks come out in the order people spoke, each at its first frame's arrival time (got ${order})`);
  ok(h.chunks[0]!.samples.length === (5_000 / FRAME_MS) * SAMPLES_PER_FRAME, "a turn chunk carries exactly its speaker's audio");
}
{
  const h = harness();
  h.speak("A", 5_000, false);
  h.advance(300);
  h.speak("B", 4_000, false);
  h.cap.streamEnd("A");
  h.advance(300);
  h.speak("A", 3_000, false);
  h.cap.streamEnd("B");
  h.cap.streamEnd("A");
  h.cap.flushAll();
  const order = h.chunks.map((c) => `${c.userId}@${c.atMs}`).join(" ");
  ok(order === "A@0 B@5300 A@9600", `a turn change cuts the previous speaker's chunk even while their stream is still open (got ${order})`);
}
{
  const h = harness();
  h.speak("A", 4_000);
  h.speak("B", 1_000);
  h.speak("A", 4_000);
  h.speak("B", 4_000);
  h.cap.flushAll();
  const order = h.chunks.map((c) => `${c.userId}@${c.atMs}`).join(" ");
  ok(order === "A@0 B@4000 A@5000 B@9000", `a short interjection is cut at the next turn change, so every turn keeps its place (got ${order})`);
  ok(h.chunks[1]!.samples.length === (1_000 / FRAME_MS) * SAMPLES_PER_FRAME, "the interjection's chunk holds only the interjection");
}
{
  const h = harness();
  h.speak("A", 30_000);
  ok(h.chunks.length === 0, "a 30 s monologue followed by a pause is not cut before 45 s");
  h.speak("A", 16_000);
  ok(h.chunks.length === 1 && h.chunks[0]!.reason === "pause", "past 45 s of audio, the first pause ends the chunk");
}
{
  const h = harness();
  h.speak("A", 80_000, false);
  ok(h.chunks.length === 1 && h.chunks[0]!.reason === "max" && h.chunks[0]!.samples.length === (RULE.maxMs / 1000) * OUT_RATE, "at 75 s of audio the chunk ends whatever is said");
  h.cap.flushAll();
  ok(h.chunks.length === 2 && h.chunks[1]!.atMs === 75_000, "the rest of the talk is the next chunk, at its own arrival time");
}
{
  const h = harness({ turnCutBudget: 1 });
  h.speak("A", 4_000);
  h.speak("B", 4_000);
  h.speak("A", 4_000);
  h.cap.flushAll();
  const order = h.chunks.map((c) => `${c.userId}:${c.reason}`).join(" ");
  ok(order === "A:turn A:end B:end" || order === "A:turn B:end A:end", `once the turn-cut budget is spent, a turn change cuts nothing (got ${order})`);
  ok(h.chunks.filter((c) => c.reason === "turn").length === 1, "exactly the budgeted number of turn cuts");
}

{
  const stereo = Int16Array.from([100, 300, 100, 300, 100, 300, -600, -600, -600, -600, -600, -600]);
  const mono = toMono16k(stereo);
  ok(mono.length === 2 && mono[0] === 200 && mono[1] === -600, "48 kHz stereo becomes 16 kHz mono: both channels and three samples averaged");
  const wav = wavFile(Int16Array.from([1, -1, 2]));
  ok(wav.toString("ascii", 0, 4) === "RIFF" && wav.toString("ascii", 8, 12) === "WAVE" && wav.readUInt32LE(24) === 16_000 && wav.readUInt16LE(22) === 1 && wav.readUInt32LE(40) === 6 && wav.readInt16LE(46) === -1, "the chunk is a 16 kHz mono 16-bit WAV file");
  const longest = (RULE.maxMs / 1000) * OUT_RATE * 2 + 44;
  ok(Math.ceil(longest / 3) * 4 < 4 * 1024 * 1024, "a 75 s chunk in base64 fits OE's 4 MB callback cap");
}

console.log(`✓ meeting-bot-discord-test: ${passed} assertions`);
