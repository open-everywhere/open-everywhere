import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AMI_ANNOTATIONS_URL, AMI_ATTRIBUTION, AMI_AUDIO_URL, mergeSpeakers, parseAmiWords, wordsInWindow, type RefWord } from "./stt-bakeoff/ami.js";
import { candidateCall, candidates, CATALOGUE_PATH, listPriceUsd, type Candidate } from "./stt-bakeoff/candidates.js";
import { chunkAudio, type Chunk, type ChunkingMode } from "./stt-bakeoff/chunking.js";
import { scoreRun, type ChunkResult, type Score } from "./stt-bakeoff/score.js";
import { durationSeconds, encodeWav, parseWav, slicePcm } from "./stt-bakeoff/wav.js";
import { readZipEntries } from "./stt-bakeoff/zip.js";

export const FIXTURE_DIR = fileURLToPath(new URL("./fixtures/stt-bakeoff/", import.meta.url));
export const DEFAULT_MEETINGS = ["ES2002a", "IS1009a", "TS3003a"];

export interface RefFixture {
  readonly attribution: string;
  readonly meeting: string;
  readonly from: number;
  readonly to: number;
  readonly words: readonly RefWord[];
}

export interface ResponseFixture {
  readonly candidate: string;
  readonly role: string;
  readonly meeting: string;
  readonly chunking: ChunkingMode;
  readonly source: string;
  readonly chunks: readonly Chunk[];
  readonly results: readonly ChunkResult[];
}

export interface Row {
  readonly candidate: string;
  readonly role: string;
  readonly meeting: string;
  readonly chunking: ChunkingMode;
  readonly audioSeconds: number;
  readonly failedChunks: number;
  readonly score: Score;
  readonly reportedCostUsd?: number;
  readonly listCostUsd?: number;
}

function pct(x: number | undefined): string {
  return x === undefined ? "—" : `${(x * 100).toFixed(1)}%`;
}

function usd(x: number | undefined): string {
  return x === undefined ? "—" : `$${x.toFixed(4)}`;
}

export function scoreRow(ref: RefFixture, r: ResponseFixture, listCostUsd?: number): Row {
  const audioSeconds = r.chunks.reduce((s, c) => s + (c.end - c.start), 0);
  const costs = r.results.map((x) => x.costUsd);
  const reported = costs.every((c) => c !== undefined) && costs.length > 0 ? costs.reduce((a, b) => a! + b!, 0) : undefined;
  return {
    candidate: r.candidate,
    role: r.role,
    meeting: r.meeting,
    chunking: r.chunking,
    audioSeconds,
    failedChunks: r.results.filter((x) => x.error !== undefined).length,
    score: scoreRun(ref.words, r.chunks, r.results),
    ...(reported !== undefined ? { reportedCostUsd: reported } : {}),
    ...(listCostUsd !== undefined ? { listCostUsd } : {}),
  };
}

export function renderReport(rows: readonly Row[]): string {
  const head = ["candidate", "meeting", "cut", "WER", "seam WER", "seam n", "interior", "timed", "time err", "speaker", "failed", "cost"];
  const lines = rows.map((r) => [
    r.candidate,
    r.meeting,
    r.chunking,
    pct(r.score.wer),
    pct(r.score.seamWer),
    String(r.score.seamWords),
    pct(r.score.interiorWer),
    pct(r.score.timedShare),
    r.score.medianTimeErrorSeconds === undefined ? "—" : `${r.score.medianTimeErrorSeconds.toFixed(2)}s`,
    pct(r.score.speakerAccuracy),
    String(r.failedChunks),
    r.reportedCostUsd !== undefined ? usd(r.reportedCostUsd) : r.listCostUsd !== undefined ? `~${usd(r.listCostUsd)}` : "unknown",
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i]!.length)));
  const fmt = (cells: readonly string[]): string => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
  const total = rows.reduce((s, r) => s + (r.reportedCostUsd ?? r.listCostUsd ?? 0), 0);
  const unknown = rows.filter((r) => r.reportedCostUsd === undefined && r.listCostUsd === undefined).length;
  return [
    fmt(head),
    ...lines.map(fmt),
    "",
    `cost of this run: ${usd(total)}${unknown > 0 ? ` (+ ${unknown} row(s) with no price)` : ""}. "~" is catalogue list price; the rest is what the provider reported.`,
    `seam n = reference words within 2 s of a cut. speaker = share of correctly recognised words placed on their true speaker by their timestamp; "—" = the route returned no timestamps.`,
  ].join("\n");
}

export function runOffline(dir: string = FIXTURE_DIR): Row[] {
  const refs = new Map<string, RefFixture>();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".ref.json")) continue;
    const ref = JSON.parse(readFileSync(join(dir, f), "utf8")) as RefFixture;
    refs.set(ref.meeting, ref);
  }
  const rows: Row[] = [];
  const respDir = join(dir, "responses");
  for (const f of readdirSync(respDir).sort()) {
    if (!f.endsWith(".json")) continue;
    const r = JSON.parse(readFileSync(join(respDir, f), "utf8")) as ResponseFixture;
    const ref = refs.get(r.meeting);
    if (ref === undefined) throw new Error(`${f}: no reference fixture for meeting ${r.meeting}`);
    rows.push(scoreRow(ref, r));
  }
  return rows;
}

async function download(url: string, path: string): Promise<Uint8Array> {
  if (existsSync(path)) return new Uint8Array(readFileSync(path));
  console.log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  writeFileSync(path, bytes);
  return bytes;
}

async function amiReference(cache: string, meeting: string): Promise<RefWord[]> {
  const zip = await download(AMI_ANNOTATIONS_URL, join(cache, "ami_public_manual_1.6.2.zip"));
  const entries = readZipEntries(zip, (name) => name.startsWith(`words/${meeting}.`) && name.endsWith(".words.xml"));
  if (entries.size === 0) throw new Error(`no AMI word annotations for meeting ${meeting}`);
  const dec = new TextDecoder("latin1");
  return mergeSpeakers([...entries].map(([name, bytes]) => parseAmiWords(dec.decode(bytes), name.split(".")[1]!)));
}

interface LiveOptions {
  readonly meetings: readonly string[];
  readonly from?: number;
  readonly to?: number;
  readonly chunking: readonly ChunkingMode[];
  readonly only?: readonly string[];
  readonly selfHostedUrl?: string;
  readonly cache: string;
  readonly record?: string;
}

async function runLive(o: LiveOptions): Promise<Row[]> {
  mkdirSync(o.cache, { recursive: true });
  const deepinfraKey = process.env.DEEPINFRA_API_KEY?.trim() || undefined;
  const pool = candidates(o.selfHostedUrl).filter((c) => o.only === undefined || o.only.includes(c.name));
  const runnable: Candidate[] = [];
  for (const c of pool) {
    if (c.route?.via === "deepinfra" && deepinfraKey === undefined) console.log(`skip ${c.name}: DEEPINFRA_API_KEY is not set`);
    else runnable.push(c);
  }
  const rows: Row[] = [];
  for (const meeting of o.meetings) {
    const full = parseWav(await download(AMI_AUDIO_URL(meeting), join(o.cache, `${meeting}.Mix-Headset.wav`)));
    const from = o.from ?? 0;
    const to = Math.min(o.to ?? durationSeconds(full), durationSeconds(full));
    const pcm = slicePcm(full, from, to);
    const words = wordsInWindow(await amiReference(o.cache, meeting), from, to).map((w) => ({ ...w, start: w.start - from, end: w.end - from }));
    const ref: RefFixture = { attribution: AMI_ATTRIBUTION, meeting, from, to, words };
    if (o.record !== undefined) {
      mkdirSync(join(o.record, "responses"), { recursive: true });
      writeFileSync(join(o.record, `${meeting}.ref.json`), JSON.stringify(ref) + "\n");
    }
    for (const mode of o.chunking) {
      const chunks = chunkAudio(pcm, mode);
      console.log(`${meeting} ${from}–${to}s, ${mode} cuts at: ${chunks.slice(1).map((c) => c.start.toFixed(2)).join(", ") || "none"}`);
      const wavs = chunks.map((c) => encodeWav(slicePcm(pcm, c.start, c.end)));
      for (const c of runnable) {
        const call = candidateCall(c, deepinfraKey);
        const results: ChunkResult[] = [];
        for (const [i, wav] of wavs.entries()) {
          try {
            const r = await call(wav);
            results.push({ text: r.text, words: r.words, segments: r.segments, ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}) });
          } catch (err) {
            const msg = (err instanceof Error ? err.message : String(err)).slice(0, 300);
            console.log(`  ${c.name} chunk ${i}: ${msg}`);
            results.push({ text: "", words: [], segments: [], error: msg });
          }
        }
        const fixture: ResponseFixture = { candidate: c.name, role: c.role, meeting, chunking: mode, source: `recorded live ${new Date().toISOString().slice(0, 10)}`, chunks, results };
        if (o.record !== undefined) writeFileSync(join(o.record, "responses", `${meeting}.${mode}.${c.name}.json`), JSON.stringify(fixture) + "\n");
        const answered = chunks.reduce((sum, ch, i) => sum + (results[i]!.error === undefined ? ch.end - ch.start : 0), 0);
        rows.push(scoreRow(ref, fixture, listPriceUsd(c, answered)));
        console.log(`  ${c.name} done`);
      }
    }
  }
  return rows;
}

async function refreshCatalogue(): Promise<void> {
  const res = await fetch("https://ai-gateway.vercel.sh/v1/models");
  if (!res.ok) throw new Error(`HTTP ${res.status} from the Gateway catalogue`);
  const live = ((await res.json()) as { data: { id: string; name: string; type: string; zdr: string; no_training: string; modalities: { input: string[] }; pricing?: Record<string, string> }[] }).data;
  const cat = JSON.parse(readFileSync(CATALOGUE_PATH, "utf8")) as { gateway: { id: string }[]; fetchedAt: string };
  const keep = ["input", "output", "audio_input_token_cost", "transcription_duration_cost_per_second"];
  cat.gateway = cat.gateway.map((row) => {
    const m = live.find((x) => x.id === row.id);
    if (m === undefined) {
      console.log(`! ${row.id} is no longer in the Gateway catalogue — row kept as it was`);
      return row;
    }
    const pricing = Object.fromEntries(Object.entries(m.pricing ?? {}).filter(([k]) => keep.includes(k)));
    return { id: m.id, name: m.name, type: m.type, zdr: m.zdr, no_training: m.no_training, inputModalities: m.modalities.input, pricing };
  });
  cat.fetchedAt = new Date().toISOString().slice(0, 10);
  writeFileSync(CATALOGUE_PATH, JSON.stringify(cat, null, 2) + "\n");
  console.log(`catalogue rows refreshed (${cat.gateway.length})`);
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  if (process.argv.includes("--refresh-catalogue")) return await refreshCatalogue();
  if (!process.argv.includes("--live")) {
    console.log(`OFFLINE replay of the committed fixtures (${FIXTURE_DIR}). Add --live for a real run.\n`);
    console.log(renderReport(runOffline()));
    return;
  }
  if (!process.env.AI_GATEWAY_API_KEY?.trim()) console.log("note: AI_GATEWAY_API_KEY is not set; the gateway candidates need it or Vercel OIDC.");
  const chunking = (arg("--chunking") ?? "both") === "both" ? (["pause", "fixed"] as const) : [arg("--chunking") as ChunkingMode];
  for (const m of chunking) if (m !== "pause" && m !== "fixed") throw new Error(`--chunking must be pause, fixed or both`);
  const from = arg("--from");
  const to = arg("--to");
  const only = arg("--candidates");
  const self = arg("--self-hosted-url");
  const record = arg("--record");
  const rows = await runLive({
    meetings: (arg("--meetings") ?? DEFAULT_MEETINGS.join(",")).split(",").map((s) => s.trim()).filter(Boolean),
    chunking,
    cache: arg("--cache") ?? "node_modules/.cache/stt-bakeoff",
    ...(from !== undefined ? { from: Number(from) } : {}),
    ...(to !== undefined ? { to: Number(to) } : {}),
    ...(only !== undefined ? { only: only.split(",") } : {}),
    ...(self !== undefined ? { selfHostedUrl: self } : {}),
    ...(record !== undefined ? { record } : {}),
  });
  console.log("\n" + renderReport(rows));
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
