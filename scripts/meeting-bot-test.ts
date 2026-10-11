import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";

const BOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "deploy", "meeting-bot");
const src = (f: string): string => readFileSync(join(BOT_DIR, f), "utf8");

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

interface CutRule {
  start(now: number): void;
  sample(now: number, level: number): "max" | "pause" | undefined;
  quietFor(now: number): number;
}
interface SpeakerSample {
  readonly t: number;
  readonly speaking: readonly string[];
  readonly quietMs: number;
}
interface Span {
  readonly name: string;
  readonly startMs: number;
  readonly endMs: number;
}
interface SpeakersApi {
  readonly SAMPLE_MS: number;
  cleanName(v: unknown): string | undefined;
  readPage(doc: unknown, platform: string, botName: string): { present: string[]; speaking: string[] };
  indicatorAgrees(samples: readonly SpeakerSample[]): boolean;
  chunkSpans(samples: readonly SpeakerSample[], startAt: number, endAt: number): Span[];
}

function loadLibs(): { OeCutRule: { rms(buf: ArrayLike<number>): number; createCutRule(): CutRule }; OeSpeakers: SpeakersApi } {
  const sandbox: Record<string, unknown> = {};
  createContext(sandbox);
  runInContext(src("cut-rule.js"), sandbox);
  runInContext(src("speakers.js"), sandbox);
  return sandbox as never;
}

const LOUD = 0.2;
const QUIET = 0.001;

{
  const { OeCutRule } = loadLibs();
  ok(Math.abs(OeCutRule.rms([0.5, -0.5, 0.5, -0.5]) - 0.5) < 1e-9 && OeCutRule.rms([]) === 0, "rms reads a block's level");

  const firstCut = (level: (t: number) => number): { at: number; why: string } | undefined => {
    const rule = OeCutRule.createCutRule();
    rule.start(0);
    for (let t = 0; t <= 120_000; t += 50) {
      const why = rule.sample(t, level(t));
      if (why !== undefined) return { at: t, why };
    }
    return undefined;
  };
  const talk = firstCut(() => LOUD);
  ok(talk?.at === 75_000 && talk.why === "max", `nonstop talk is cut at 75 s, never later (got ${JSON.stringify(talk)})`);
  const pause = firstCut((t) => (t >= 50_000 && t < 52_000 ? QUIET : LOUD));
  ok(pause?.at === 50_500 && pause.why === "pause", `a pause at 50 s cuts the chunk 0.5 s into the pause (got ${JSON.stringify(pause)})`);
  const early = firstCut((t) => (t >= 20_000 && t < 23_000 ? QUIET : LOUD));
  ok(early?.at === 75_000, `a pause before 45 s does not end the chunk (got ${JSON.stringify(early)})`);
  const across = firstCut((t) => (t >= 44_000 && t < 47_000 ? QUIET : LOUD));
  ok(across?.at === 45_000 && across.why === "pause", `a pause already running at 45 s cuts at 45 s (got ${JSON.stringify(across)})`);
  const short = firstCut((t) => (t % 2_000 < 400 && t >= 45_000 ? QUIET : LOUD));
  ok(short?.at === 75_000, `pauses shorter than 0.5 s never cut (got ${JSON.stringify(short)})`);
}

class El {
  constructor(
    readonly textContent: string,
    readonly inner: Record<string, El[]> = {},
  ) {}
  querySelector(sel: string): El | null {
    return this.inner[sel]?.[0] ?? null;
  }
  querySelectorAll(sel: string): El[] {
    return this.inner[sel] ?? [];
  }
}
const meetTile = (name: string, speaking: boolean): El =>
  new El("", { "span.notranslate": [new El(name)], ...(speaking ? { ".HX2H7": [new El("")] } : {}) });
const teamsTile = (name: string, speaking: boolean): El =>
  new El("", {
    '[data-tid*="display-name"]': [new El(name)],
    ...(speaking ? { '[data-tid="voice-level-stream-outline"].vdi-frame-occlusion': [new El("")] } : {}),
  });

{
  const { OeSpeakers } = loadLibs();
  const meetDoc = new El("", { "[data-participant-id]": [meetTile("Ana Lima", true), meetTile("Ben", false), meetTile("Meeting notetaker", false), meetTile("You", false), meetTile("  ", true)] });
  const meet = OeSpeakers.readPage(meetDoc, "meet", "Meeting notetaker");
  ok(meet.present.join("|") === "Ana Lima|Ben" && meet.speaking.join("|") === "Ana Lima", `Meet: the reader reads names and the speaking tile, without the bot, "You" or a nameless tile (got ${JSON.stringify(meet)})`);
  const teamsDoc = new El("", { '[data-cid="calling-participant-stream"]': [teamsTile("Chen <!here>", true), teamsTile("Dee", false)] });
  const teams = OeSpeakers.readPage(teamsDoc, "teams", "Meeting notetaker");
  ok(teams.present.join("|") === "Chen !here|Dee" && teams.speaking.join("|") === "Chen !here", `Teams: the reader reads names and the speaking tile, and strips brackets (got ${JSON.stringify(teams)})`);
  ok(OeSpeakers.readPage(meetDoc, "zoom", "x").present.length === 0, "an unknown platform reads nothing");
  ok(OeSpeakers.cleanName("a‮b\nc " + "x".repeat(100))?.length === 64 && OeSpeakers.cleanName("[]<>") === undefined, "a name is cleaned of control and bracket characters and capped at 64");

  const talking = (t: number): string | undefined => (t < 20_000 ? "Ana" : t < 23_000 ? undefined : t < 40_000 ? "Ben" : t < 43_000 ? undefined : "Ana");
  const quietMs = (t: number): number => (talking(t) !== undefined ? 0 : t - (t < 23_000 ? 20_000 : 40_000));
  const timeline = (indicator: (t: number) => readonly string[]): SpeakerSample[] => {
    const out: SpeakerSample[] = [];
    for (let t = 0; t < 60_000; t += OeSpeakers.SAMPLE_MS) out.push({ t, speaking: indicator(t), quietMs: quietMs(t) });
    return out;
  };
  const honest = timeline((t) => {
    const n = talking(t);
    return n === undefined ? [] : [n];
  });
  ok(OeSpeakers.indicatorAgrees(honest), "an indicator that follows the audio passes the agreement check");
  const spans = OeSpeakers.chunkSpans(honest, 10_000, 50_000);
  ok(
    JSON.stringify(spans) === JSON.stringify([{ name: "Ana", startMs: 0, endMs: 10_000 }, { name: "Ben", startMs: 13_000, endMs: 30_000 }, { name: "Ana", startMs: 33_000, endMs: 40_000 }]),
    `the spans fall inside the chunk, in ms from ITS start, one per run (got ${JSON.stringify(spans)})`,
  );
  const alwaysOn = timeline(() => ["Ana"]);
  ok(!OeSpeakers.indicatorAgrees(alwaysOn) && OeSpeakers.chunkSpans(alwaysOn, 0, 60_000).length === 0, "an indicator lit through the silences (always-on or inverted) gives NO spans");
  const inverted = timeline((t) => (talking(t) === "Ana" ? ["Ben"] : talking(t) === "Ben" ? ["Ana"] : ["Ana", "Ben"]));
  ok(OeSpeakers.chunkSpans(inverted, 0, 60_000).length === 0, "an inverted indicator gives NO spans");
  const dead = timeline(() => []);
  ok(OeSpeakers.chunkSpans(dead, 0, 60_000).length === 0, "a selector that matches nothing gives no spans");
  const late: SpeakerSample[] = [];
  for (let t = 0; t < 180_000; t += OeSpeakers.SAMPLE_MS) {
    if (t < 135_000) {
      const s = t % 30_000;
      const quiet = s >= 27_000;
      late.push({ t, speaking: quiet ? [] : [s < 13_000 ? "Ana" : "Ben"], quietMs: quiet ? s - 27_000 : 0 });
    } else {
      const quiet = t >= 160_000 && t < 161_500;
      late.push({ t, speaking: ["Ana"], quietMs: quiet ? t - 160_000 : 0 });
    }
  }
  ok(OeSpeakers.indicatorAgrees(late.filter((x) => x.t < 180_000)), "(setup) the window as a whole still passes the check");
  ok(OeSpeakers.chunkSpans(late, 135_000, 180_000).length === 0, "an indicator that breaks inside the chunk gives NO spans, though the window passes");
  const noPause = honest.map((s) => ({ ...s, quietMs: 0 }));
  ok(!OeSpeakers.indicatorAgrees(noPause), "a window with no long silence cannot be checked, so it gives no spans");
}

interface RecEvent {
  readonly what: "start" | "stop";
  readonly rec: number;
  readonly at: number;
}
interface Delivered {
  readonly seq: number;
  readonly base64: string;
  readonly meta: { speakers: Span[]; attendees: string[] };
}

interface PageOpts {
  readonly slowRecorder?: number;
  readonly stuckRecorder?: number;
  readonly holdSeq?: number;
}

function fakePage(level: (t: number) => number, doc: El = new El(""), opts: PageOpts = {}) {
  const { slowRecorder, stuckRecorder, holdSeq } = opts;
  const timeouts: { at: number; fn: () => void }[] = [];
  const handedOff: number[] = [];
  let release: () => void = () => {};
  let now = 0;
  const events: RecEvent[] = [];
  const delivered: Delivered[] = [];
  const intervals = new Map<number, () => void>();
  let nextTimer = 1;
  let recorders = 0;
  class FakeRecorder {
    readonly id = recorders++;
    state = "inactive";
    ondataavailable: ((e: { data: { size: number; id: number } }) => void) | null = null;
    onstop: (() => Promise<void> | void) | null = null;
    start(): void {
      this.state = "recording";
      events.push({ what: "start", rec: this.id, at: now });
    }
    stop(): void {
      this.state = "inactive";
      events.push({ what: "stop", rec: this.id, at: now });
      this.ondataavailable?.({ data: { size: 1, id: this.id } });
      if (this.id !== stuckRecorder) queueMicrotask(() => void this.onstop?.());
    }
  }
  const node = () => ({ connect() {} });
  const page: Record<string, unknown> = {
    MediaRecorder: FakeRecorder,
    MediaStream: class {},
    Blob: class {
      constructor(readonly parts: { id: number }[]) {}
      async arrayBuffer(): Promise<ArrayBuffer> {
        if (this.parts[0]?.id === slowRecorder) await new Promise((r) => setTimeout(r, 30));
        return new Uint8Array(this.parts.map((p) => 65 + p.id)).buffer;
      }
    },
    Float32Array,
    Uint8Array,
    Set,
    Promise,
    String,
    Math,
    btoa: (s: string) => Buffer.from(s, "binary").toString("base64"),
    AudioContext: class {
      state = "running";
      createGain = node;
      createMediaStreamDestination = () => ({ stream: {}, connect() {} });
      createMediaStreamSource = node;
      createAnalyser = () => ({
        fftSize: 2048,
        connect() {},
        getFloatTimeDomainData(buf: Float32Array) {
          buf.fill(level(now));
        },
      });
    },
    RTCPeerConnection: class {},
    performance: { now: () => now },
    setInterval: (fn: () => void) => {
      intervals.set(nextTimer, fn);
      return nextTimer++;
    },
    clearInterval: (id: number) => intervals.delete(id),
    setTimeout: (fn: () => void, ms: number) => {
      timeouts.push({ at: now + ms, fn });
      return timeouts.length;
    },
    document: Object.assign(doc, { documentElement: { appendChild() {} }, createElement: () => ({ style: {}, play: async () => {} }) }),
    oeChunk: async (seq: number, base64: string, meta: Delivered["meta"]) => {
      handedOff.push(seq);
      if (seq === holdSeq) await new Promise<void>((r) => (release = r));
      delivered.push({ seq, base64, meta });
    },
  };
  page.window = page;
  createContext(page);
  runInContext([src("cut-rule.js"), src("speakers.js"), src("capture.js")].join("\n;\n"), page);
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  };
  return {
    page: page as { __oeStartCapture(o: unknown): void; __oeStopCapture(): Promise<number> },
    events,
    delivered,
    handedOff,
    release: () => release(),
    async run(until: number): Promise<void> {
      while (now < until) {
        now += 50;
        for (const fn of [...intervals.values()]) fn();
        for (const t of timeouts.splice(0).filter((x) => (x.at <= now ? (x.fn(), false) : true))) timeouts.push(t);
        await flush();
      }
    },
  };
}

{
  const level = (t: number): number => ((t > 30_000 && t <= 32_000) || (t > 60_000 && t <= 61_000) ? QUIET : LOUD);
  const doc = new El("", { "[data-participant-id]": [meetTile("Ana", true), meetTile("Meeting notetaker", false)] });
  const p = fakePage(level, doc);
  p.page.__oeStartCapture({ platform: "meet", botName: "Meeting notetaker" });
  await p.run(200_000);
  const seqAfterStop = await p.page.__oeStopCapture();

  const starts = p.events.filter((e) => e.what === "start");
  const stops = p.events.filter((e) => e.what === "stop");
  const bounds = starts.map((s) => s.at);
  ok(JSON.stringify(bounds) === JSON.stringify([0, 60_550, 135_550]), `chunks start at 0, at the first pause after 45 s, and 75 s later under nonstop talk (got ${JSON.stringify(bounds)})`);
  for (let i = 1; i < starts.length; i++) {
    const nextStart = p.events.indexOf(starts[i]!);
    const prevStop = p.events.findIndex((e) => e.what === "stop" && e.rec === starts[i - 1]!.rec);
    ok(nextStart >= 0 && prevStop > nextStart, `handover ${i}: the next recorder starts BEFORE the previous one stops`);
    ok(p.events[prevStop]!.at === starts[i]!.at, `handover ${i}: the previous chunk ends at the very instant the next begins (no gap)`);
  }
  ok(stops.length === starts.length && stops[stops.length - 1]!.at === 200_000, "stop ends the last chunk at the stop time");
  ok(seqAfterStop === 3 && p.delivered.map((d) => d.seq).join(",") === "0,1,2", `every chunk reaches the bot once, in order (got ${p.delivered.map((d) => d.seq).join(",")})`);
  ok(p.delivered.every((d) => d.meta.attendees.join("|") === "Ana"), "each chunk carries the names on the page, without the bot's own");
}

{
  let speaking = false;
  const level = (t: number): number => {
    const s = t % 10_000;
    speaking = s >= 2_000;
    return speaking ? LOUD : QUIET;
  };
  const tile = { get inner(): Record<string, El[]> {
    return { "span.notranslate": [new El("Ana")], ...(speaking ? { ".HX2H7": [new El("")] } : {}) };
  } };
  const liveTile = new (class extends El {
    override querySelector(sel: string): El | null {
      return tile.inner[sel]?.[0] ?? null;
    }
  })("");
  const doc = new El("", { "[data-participant-id]": [liveTile] });
  const p = fakePage(level, doc);
  p.page.__oeStartCapture({ platform: "meet", botName: "Meeting notetaker" });
  await p.run(70_000);
  await p.page.__oeStopCapture();
  const first = p.delivered[0];
  ok(first !== undefined && first.meta.speakers.length > 0 && first.meta.speakers.every((s) => s.name === "Ana" && s.startMs >= 0), `a chunk carries the speaker spans that agree with the audio (got ${JSON.stringify(first?.meta.speakers.slice(0, 3))})`);
}

{
  const p = fakePage(() => LOUD, new El(""), { slowRecorder: 0 });
  p.page.__oeStartCapture({ platform: "meet", botName: "Meeting notetaker" });
  await p.run(75_050);
  await p.page.__oeStopCapture();
  ok(p.delivered.map((d) => d.seq).join(",") === "0,1", `a slow earlier chunk still reaches the bot first (got ${p.delivered.map((d) => d.seq).join(",")})`);
}

async function stopWithin(page: { __oeStopCapture(): Promise<number> }, label: string): Promise<void> {
  const settled = await Promise.race([page.__oeStopCapture().then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 2_000))]);
  ok(settled, `${label}: the stop settles`);
}

{
  const p = fakePage(() => LOUD, new El(""), { holdSeq: 0 });
  p.page.__oeStartCapture({ platform: "meet", botName: "Meeting notetaker" });
  await p.run(75_050);
  await stopWithin(p.page, "chunk 0's send pending at stop");
  ok(p.handedOff.join(",") === "0,1" && !p.delivered.some((d) => d.seq === 0), `with chunk 0's send still pending, stop still hands chunk 1 over, after chunk 0 (got hand-offs ${p.handedOff.join(",")})`);
  p.release();
  await new Promise((r) => setImmediate(r));
  ok(p.delivered.some((d) => d.seq === 0), "chunk 0 completes once OE answers (the bot's own queue sends in hand-off order)");
}

{
  const p = fakePage(() => LOUD, new El(""), { stuckRecorder: 0 });
  p.page.__oeStartCapture({ platform: "meet", botName: "Meeting notetaker" });
  await p.run(75_000 + 31_000);
  await stopWithin(p.page, "a recorder that never stops");
  ok(p.handedOff.join(",") === "1", `a recorder that never stops loses only its own chunk (got hand-offs ${p.handedOff.join(",")})`);
}

console.log(`✓ meeting-bot-test: ${passed} assertions`);
