import type { RefWord } from "./ami.js";
import type { Chunk } from "./chunking.js";

export interface ChunkResult {
  readonly text: string;
  readonly words: readonly { text: string; startSecond: number; endSecond: number }[];
  readonly segments: readonly { text: string; startSecond: number; endSecond: number }[];
  readonly costUsd?: number;
  readonly error?: string;
}

const FILLERS = new Set(["um", "uh", "hmm", "hm", "mm", "mmm", "mhm", "mm-hmm", "uh-huh", "er", "erm", "ah", "eh"]);
const SAME: Record<string, readonly string[]> = {
  gonna: ["going", "to"],
  wanna: ["want", "to"],
  gotta: ["got", "to"],
  alright: ["all", "right"],
  ok: ["okay"],
  favourite: ["favorite"],
  colour: ["color"],
  colours: ["colors"],
  centre: ["center"],
};
const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

function numberWords(n: number): string[] {
  if (n < 20) return [ONES[n]!];
  if (n < 100) return n % 10 === 0 ? [TENS[Math.floor(n / 10)]!] : [TENS[Math.floor(n / 10)]!, ONES[n % 10]!];
  if (n < 1000) return [ONES[Math.floor(n / 100)]!, "hundred", ...(n % 100 === 0 ? [] : numberWords(n % 100))];
  return [String(n)];
}

export function normalize(text: string): string[] {
  const out: string[] = [];
  const cleaned = text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9'\- ]+/g, " ");
  for (const raw of cleaned.split(/\s+/)) {
    const w = raw.replace(/^['-]+|['-]+$/g, "");
    if (w === "" || FILLERS.has(w)) continue;
    for (const part of w.split("-")) {
      if (part === "" || FILLERS.has(part)) continue;
      if (/^[0-9]+$/.test(part)) out.push(...numberWords(Number(part)));
      else out.push(...(SAME[part] ?? [part]));
    }
  }
  return out;
}

export interface RefToken {
  readonly text: string;
  readonly mid: number;
  readonly speaker: string;
}

export interface HypToken {
  readonly text: string;
  readonly mid?: number;
  readonly chunk: number;
}

export function refTokens(words: readonly RefWord[], offset: number): RefToken[] {
  const out: RefToken[] = [];
  for (const w of words) for (const t of normalize(w.text)) out.push({ text: t, mid: (w.start + w.end) / 2 - offset, speaker: w.speaker });
  return out;
}

function spanTokens(span: { text: string; startSecond: number; endSecond: number }, base: number, chunk: number): HypToken[] {
  const toks = normalize(span.text);
  const d = span.endSecond - span.startSecond;
  return toks.map((t, j) => ({ text: t, mid: base + span.startSecond + ((j + 0.5) / toks.length) * d, chunk }));
}

export function hypTokens(r: ChunkResult, chunk: Chunk): HypToken[] {
  const textToks = normalize(r.text);
  for (const spans of [r.words, r.segments]) {
    if (spans.length === 0) continue;
    const timed = spans.flatMap((s) => spanTokens(s, chunk.start, chunk.index));
    if (timed.length === textToks.length) return timed;
  }
  return textToks.map((t) => ({ text: t, chunk: chunk.index }));
}

export type Op = { kind: "ok" | "sub"; r: number; h: number } | { kind: "del"; r: number } | { kind: "ins"; h: number };

export function align(ref: readonly string[], hyp: readonly string[]): Op[] {
  const n = ref.length;
  const m = hyp.length;
  const back = new Uint8Array((n + 1) * (m + 1));
  let prev = new Uint32Array(m + 1);
  let cur = new Uint32Array(m + 1);
  for (let j = 0; j <= m; j++) {
    prev[j] = j;
    back[j] = 2;
  }
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    back[i * (m + 1)] = 1;
    for (let j = 1; j <= m; j++) {
      const diag = prev[j - 1]! + (ref[i - 1] === hyp[j - 1] ? 0 : 1);
      const up = prev[j]! + 1;
      const left = cur[j - 1]! + 1;
      let best = diag;
      let dir = 0;
      if (up < best) {
        best = up;
        dir = 1;
      }
      if (left < best) {
        best = left;
        dir = 2;
      }
      cur[j] = best;
      back[i * (m + 1) + j] = dir;
    }
    [prev, cur] = [cur, prev];
  }
  const ops: Op[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const dir = i === 0 ? 2 : j === 0 ? 1 : back[i * (m + 1) + j]!;
    if (dir === 0) {
      ops.push({ kind: ref[i - 1] === hyp[j - 1] ? "ok" : "sub", r: i - 1, h: j - 1 });
      i--;
      j--;
    } else if (dir === 1) {
      ops.push({ kind: "del", r: i - 1 });
      i--;
    } else {
      ops.push({ kind: "ins", h: j - 1 });
      j--;
    }
  }
  return ops.reverse();
}

export function speakerAt(spans: readonly { start: number; end: number; speaker: string }[], t: number): string | undefined {
  let best: string | undefined;
  let bestGap = 1;
  for (const s of spans) {
    if (t >= s.start && t <= s.end) return s.speaker;
    const gap = t < s.start ? s.start - t : t - s.end;
    if (gap < bestGap) {
      bestGap = gap;
      best = s.speaker;
    }
  }
  return best;
}

export interface Score {
  readonly refWords: number;
  readonly hypWords: number;
  readonly substitutions: number;
  readonly deletions: number;
  readonly insertions: number;
  readonly wer: number;
  readonly seamWords: number;
  readonly seamWer: number;
  readonly interiorWer: number;
  readonly timedShare: number;
  readonly medianTimeErrorSeconds?: number;
  readonly speakerAccuracy?: number;
}

function median(xs: number[]): number | undefined {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const k = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[k]! : (s[k - 1]! + s[k]!) / 2;
}

export function scoreRun(words: readonly RefWord[], chunks: readonly Chunk[], results: readonly ChunkResult[], seamSeconds = 2): Score {
  const ref = refTokens(words, 0);
  const hyp = chunks.flatMap((c, i) => (results[i] === undefined || results[i]!.error !== undefined ? [] : hypTokens(results[i]!, c)));
  const ops = align(
    ref.map((t) => t.text),
    hyp.map((t) => t.text),
  );
  const cuts = chunks.slice(1).map((c) => c.start);
  const onSeam = ref.map((t) => cuts.some((c) => Math.abs(t.mid - c) <= seamSeconds));
  const errAt = new Array<number>(ref.length).fill(0);
  let s = 0;
  let d = 0;
  let ins = 0;
  let lastRef = -1;
  const pendingIns: number[] = [];
  const timeErrors: number[] = [];
  let spoken = 0;
  let spokenRight = 0;
  const spans = words.map((w) => ({ start: w.start, end: w.end, speaker: w.speaker }));
  for (const op of ops) {
    if (op.kind === "ins") {
      ins++;
      if (lastRef >= 0) errAt[lastRef]!++;
      else pendingIns.push(op.h);
      continue;
    }
    lastRef = op.r;
    if (pendingIns.length > 0) {
      errAt[op.r]! += pendingIns.length;
      pendingIns.length = 0;
    }
    if (op.kind === "sub") {
      s++;
      errAt[op.r]!++;
    } else if (op.kind === "del") {
      d++;
      errAt[op.r]!++;
    } else {
      const h = hyp[op.h]!;
      if (h.mid !== undefined) {
        timeErrors.push(Math.abs(h.mid - ref[op.r]!.mid));
        const who = speakerAt(spans, h.mid);
        spoken++;
        if (who === ref[op.r]!.speaker) spokenRight++;
      }
    }
  }
  const sum = (pick: (i: number) => boolean): [number, number] => {
    let e = 0;
    let c = 0;
    for (let i = 0; i < ref.length; i++) {
      if (!pick(i)) continue;
      e += errAt[i]!;
      c++;
    }
    return [e, c];
  };
  const [seamErr, seamCount] = sum((i) => onSeam[i]!);
  const [intErr, intCount] = sum((i) => !onSeam[i]!);
  const timed = hyp.filter((t) => t.mid !== undefined).length;
  const med = median(timeErrors);
  return {
    refWords: ref.length,
    hypWords: hyp.length,
    substitutions: s,
    deletions: d,
    insertions: ins,
    wer: ref.length === 0 ? 0 : (s + d + ins) / ref.length,
    seamWords: seamCount,
    seamWer: seamCount === 0 ? 0 : seamErr / seamCount,
    interiorWer: intCount === 0 ? 0 : intErr / intCount,
    timedShare: hyp.length === 0 ? 0 : timed / hyp.length,
    ...(med !== undefined ? { medianTimeErrorSeconds: med } : {}),
    ...(spoken > 0 ? { speakerAccuracy: spokenRight / spoken } : {}),
  };
}
