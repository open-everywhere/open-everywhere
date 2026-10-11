import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { mergeSpeakers, parseAmiWords, type RefWord } from "./stt-bakeoff/ami.js";
import { candidates, listPriceUsd } from "./stt-bakeoff/candidates.js";
import { fixedChunks, pauseChunksFromMask, silenceThreshold, type Chunk } from "./stt-bakeoff/chunking.js";
import { align, normalize, scoreRun, type ChunkResult } from "./stt-bakeoff/score.js";
import { encodeWav, parseWav, slicePcm } from "./stt-bakeoff/wav.js";
import { readZipEntries } from "./stt-bakeoff/zip.js";
import { renderReport, runOffline } from "./stt-bakeoff.js";
import { TRANSCRIPTION } from "../agent/model/stacks.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}
const near = (a: number | undefined, b: number, eps = 1e-6): boolean => a !== undefined && Math.abs(a - b) < eps;

ok(normalize("Um, I'm David — the Industrial-Designer. 25 Mm-hmm! Gonna, favourite").join(" ") === "i'm david the industrial designer twenty five going to favorite", "normalise: case, punctuation, hyphens, fillers, numbers and same-word spellings");
{
  const ops = align(["a", "b", "c", "d"], ["a", "x", "c", "d", "e"]);
  const count = (k: string): number => ops.filter((o) => o.kind === k).length;
  ok(count("ok") === 3 && count("sub") === 1 && count("ins") === 1 && count("del") === 0, "align: one substitution and one insertion");
  ok(align(["a", "b"], []).every((o) => o.kind === "del") && align([], ["a"]).every((o) => o.kind === "ins"), "align: empty sides are all deletions or all insertions");
}

const REF: RefWord[] = Array.from({ length: 20 }, (_, i) => ({ text: `w${String.fromCharCode(97 + i)}`, start: i, end: i + 0.8, speaker: i < 10 ? "A" : "B" }));
const CUT: Chunk[] = [
  { index: 0, start: 0, end: 10 },
  { index: 1, start: 10, end: 20 },
];
function wordsAnswer(a: number, b: number, shift = 0, drop: readonly number[] = []): ChunkResult {
  const ws = REF.slice(a, b).filter((_, k) => !drop.includes(a + k));
  const base = a < 10 ? 0 : 10;
  const words = ws.map((w) => ({ text: w.text, startSecond: w.start - base + shift, endSecond: w.end - base + shift }));
  return { text: ws.map((w) => w.text).join(" "), words, segments: [], costUsd: 0.001 };
}
{
  const s = scoreRun(REF, CUT, [wordsAnswer(0, 10), wordsAnswer(10, 20)]);
  ok(s.wer === 0 && s.timedShare === 1 && s.speakerAccuracy === 1 && near(s.medianTimeErrorSeconds, 0), "a perfect timed run: WER 0, every word timed and on its speaker");
  ok(s.seamWords === 4, "the seam holds the reference words within 2 s of the cut (8, 9, 10 and 11 s)");
}
{
  const s = scoreRun(REF, CUT, [wordsAnswer(0, 10, 0, [9]), wordsAnswer(10, 20, 0, [10])]);
  ok(s.deletions === 2 && near(s.wer, 2 / 20) && near(s.seamWer, 2 / 4) && s.interiorWer === 0, "words lost at the cut count as seam damage only");
}
{
  const s = scoreRun(REF, CUT, [wordsAnswer(0, 10, 0, [2]), wordsAnswer(10, 20, 0, [17])]);
  ok(s.seamWer === 0 && near(s.interiorWer, 2 / 16), "words lost away from the cut are interior damage");
}
{
  const plain = (a: number, b: number): ChunkResult => ({ text: REF.slice(a, b).map((w) => w.text).join(" "), words: [], segments: [] });
  const s = scoreRun(REF, CUT, [plain(0, 10), plain(10, 20)]);
  ok(s.wer === 0 && s.timedShare === 0 && s.speakerAccuracy === undefined && s.medianTimeErrorSeconds === undefined, "no timestamps: the speaker score is absent, never guessed");
}
{
  const s = scoreRun(REF, CUT, [wordsAnswer(0, 10, 3), wordsAnswer(10, 20, 3)]);
  ok(near(s.medianTimeErrorSeconds, 3) && s.speakerAccuracy !== undefined && s.speakerAccuracy < 1 && s.speakerAccuracy > 0.5, "late timestamps cost speaker accuracy");
}
{
  const seg = (a: number, b: number): ChunkResult => {
    const text = REF.slice(a, b).map((w) => w.text).join(" ");
    return { text, words: [], segments: [{ text, startSecond: 0, endSecond: 10 }] };
  };
  const s = scoreRun(REF, CUT, [seg(0, 10), seg(10, 20)]);
  ok(s.timedShare === 1 && s.speakerAccuracy === 1 && s.medianTimeErrorSeconds !== undefined && s.medianTimeErrorSeconds < 0.2, "segment timestamps are interpolated per word");
}
{
  const s = scoreRun(REF, CUT, [wordsAnswer(0, 10), { text: "", words: [], segments: [], error: "HTTP 503" }]);
  ok(s.deletions === 10 && near(s.wer, 0.5), "a failed chunk's words are deletions");
}

ok(JSON.stringify(fixedChunks(130).map((c) => [c.start, c.end])) === "[[0,60],[60,120],[120,130]]", "fixed: 60-second chunks and the remainder");
{
  const mask = (total: number, silences: readonly [number, number][]): boolean[] =>
    Array.from({ length: Math.round(total / 0.02) }, (_, f) => silences.some(([a, b]) => f * 0.02 >= a && f * 0.02 < b));
  const cuts = (total: number, silences: readonly [number, number][]): number[] => pauseChunksFromMask(mask(total, silences), total).slice(1).map((c) => Math.round(c.start * 100) / 100);
  ok(cuts(200, []).join() === "75,150", "pause: with no pause, a forced cut every 75 s");
  ok(cuts(120, [[50, 51]]).join() === "50.25", "pause: the cut falls in the middle of the first 0.5 s of the first pause after 45 s");
  ok(cuts(120, [[30, 31]]).join() === "75", "pause: a pause before 45 s does not cut");
  ok(cuts(120, [[44.8, 46]]).join() === "45.05", "pause: a pause across 45 s cuts once 0.5 s of it is heard, in the middle of that 0.5 s");
  ok(cuts(120, [[44.2, 46]]).join() === "45", "pause: a pause heard before 45 s cuts at 45 s, never before");
  ok(cuts(120, [[50, 50.3]]).join() === "75", "pause: a pause shorter than 0.5 s does not cut");
  ok(cuts(70, []).length === 0, "pause: audio shorter than 75 s is one chunk");
  const levels = Float64Array.from({ length: 1000 }, (_, i) => (i % 3 === 0 ? 0.0001 : 0.005));
  const t = silenceThreshold(levels);
  ok(t > 0.0001 && t < 0.005, "pause: the silence threshold sits under quiet speech and over the noise floor");
}

{
  const pcm = { rate: 16000, samples: Int16Array.from({ length: 16000 }, (_, i) => (i % 100) * 10) };
  const back = parseWav(encodeWav(pcm));
  ok(back.rate === 16000 && back.samples.length === 16000 && back.samples[57] === 570, "WAV: encode then parse is lossless");
  ok(slicePcm(back, 0.5, 0.75).samples.length === 4000, "WAV: a slice is the right length");
  const stereo = encodeWav({ rate: 8000, samples: Int16Array.from([100, 300, -200, 0]) });
  const v = new DataView(stereo.buffer);
  v.setUint16(22, 2, true);
  v.setUint32(28, 8000 * 4, true);
  v.setUint16(32, 4, true);
  const mono = parseWav(stereo);
  ok(mono.samples.length === 2 && mono.samples[0] === 200 && mono.samples[1] === -100, "WAV: stereo mixes down to mono");
  assert.throws(() => parseWav(new Uint8Array(12)), /not a RIFF/);
  passed++;
}
{
  const enc = new TextEncoder();
  const entries = [
    { name: "words/X.A.words.xml", data: enc.encode("stored body"), method: 0 },
    { name: "other.txt", data: enc.encode("skip me"), method: 0 },
    { name: "words/X.B.words.xml", data: enc.encode("deflated body ".repeat(20)), method: 8 },
  ];
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let off = 0;
  for (const e of entries) {
    const body = e.method === 8 ? new Uint8Array(deflateRawSync(e.data)) : e.data;
    const name = enc.encode(e.name);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, e.method, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, e.data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, e.method, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, e.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, off, true);
    cd.set(name, 46);
    parts.push(local, body);
    central.push(cd);
    off += local.length + body.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, off, true);
  const zip = new Uint8Array(Buffer.concat([...parts, ...central, eocd]));
  const got = readZipEntries(zip, (n) => n.startsWith("words/"));
  const dec = new TextDecoder();
  ok(got.size === 2 && dec.decode(got.get("words/X.A.words.xml")!) === "stored body", "ZIP: a stored entry, and only the wanted ones");
  ok(dec.decode(got.get("words/X.B.words.xml")!) === "deflated body ".repeat(20), "ZIP: a deflated entry inflates");
}
{
  const xml = `<nite:root>
   <w nite:id="a0" starttime="77.44" endtime="77.74">Hi</w>
   <w nite:id="a1" starttime="77.74" endtime="77.74" punc="true">,</w>
   <vocalsound nite:id="a2" starttime="78.0" endtime="78.1" type="laugh"/>
   <w nite:id="a3" starttime="78.16" endtime="78.6">I&#39;m</w>
   <w nite:id="a4">untimed</w>
</nite:root>`;
  const w = parseAmiWords(xml, "A");
  ok(w.length === 2 && w[1]!.text === "I'm" && w[0]!.start === 77.44 && w[0]!.speaker === "A", "AMI: words with times, entities decoded; punctuation, vocal sounds and untimed words dropped");
  const merged = mergeSpeakers([w, [{ text: "yes", start: 77.5, end: 77.6, speaker: "B" }]]);
  ok(merged.map((x) => x.speaker).join("") === "ABA", "AMI: speakers merge into one timeline by start time");
}

{
  const c = candidates();
  const by = (n: string) => c.find((x) => x.name === n)!;
  ok(by("mai").route === TRANSCRIPTION["american-closed"].primary && by("grok").route === TRANSCRIPTION["american-closed"].fallback, "the American candidates are the american-closed routes");
  ok(by("qwen3-asr-deepinfra").route === TRANSCRIPTION["chinese-open-weights"].primary, "the DeepInfra candidate is the chinese-open-weights primary");
  ok(!c.some((x) => x.name === "qwen3-asr-self-hosted"), "the self-hosted candidate needs a URL");
  const self = candidates("http://localhost:8000/v1").find((x) => x.name === "qwen3-asr-self-hosted")!;
  ok(self.route?.baseUrl === "http://localhost:8000/v1" && self.route.id === TRANSCRIPTION["chinese-open-weights"].fallback.id, "--self-hosted-url points the self-hosted route at the operator's server");
  ok(near(listPriceUsd(by("grok"), 60), 60 * 0.000028) && near(listPriceUsd(by("qwen3-asr-deepinfra"), 120), 0.0009), "list price: per second on the Gateway, per minute on DeepInfra");
  ok(listPriceUsd(by("gpt-4o-transcribe"), 60) === undefined, "a token-priced model has no list price by duration");
}

{
  const rows = runOffline();
  ok(rows.length === 6, "offline: every committed recording is scored");
  for (const r of rows) {
    ok(r.score.refWords > 300 && r.score.wer < 0.5 && r.failedChunks === 0, `offline: ${r.candidate}/${r.chunking} scores against the AMI reference (WER ${(r.score.wer * 100).toFixed(1)}%)`);
    ok(r.reportedCostUsd !== undefined && r.reportedCostUsd > 0, `offline: ${r.candidate}/${r.chunking} carries the cost the Gateway reported`);
  }
  for (const r of rows.filter((x) => x.candidate === "grok")) {
    ok(r.score.timedShare === 1 && r.score.speakerAccuracy !== undefined && r.score.speakerAccuracy > 0.8, `offline: grok's word timestamps place speakers (${r.chunking})`);
  }
  for (const r of rows.filter((x) => x.candidate !== "grok")) ok(r.score.timedShare === 0, `offline: ${r.candidate} returned no timestamps`);
  const report = renderReport(rows);
  ok(report.includes("cost of this run: $") && report.split("\n").length === rows.length + 4, "the report prints one line per run and the cost of the run");
}

console.log(`✓ stt-bakeoff: ${passed} assertions`);
