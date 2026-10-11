import type { Pcm } from "./wav.js";

export interface Chunk {
  readonly index: number;
  readonly start: number;
  readonly end: number;
}

export type ChunkingMode = "fixed" | "pause";

export interface PauseRule {
  readonly minSeconds: number;
  readonly maxSeconds: number;
  readonly pauseSeconds: number;
}

export const FIXED_SECONDS = 60;
export const PAUSE_RULE: PauseRule = { minSeconds: 45, maxSeconds: 75, pauseSeconds: 0.5 };
const FRAME_SECONDS = 0.02;

export function fixedChunks(totalSeconds: number, seconds = FIXED_SECONDS): Chunk[] {
  const out: Chunk[] = [];
  for (let s = 0, i = 0; s < totalSeconds - 1e-9; s += seconds, i++) out.push({ index: i, start: s, end: Math.min(totalSeconds, s + seconds) });
  return out;
}

export function frameRms(pcm: Pcm): Float64Array {
  const size = Math.max(1, Math.round(pcm.rate * FRAME_SECONDS));
  const frames = Math.floor(pcm.samples.length / size);
  const out = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = f * size; i < (f + 1) * size; i++) {
      const s = pcm.samples[i]! / 32768;
      sum += s * s;
    }
    out[f] = Math.sqrt(sum / size);
  }
  return out;
}

export function silenceThreshold(rms: Float64Array): number {
  if (rms.length === 0) return 0.001;
  const sorted = Float64Array.from(rms).sort();
  return Math.max(0.001, 3 * sorted[Math.floor(sorted.length * 0.1)]!);
}

export function pauseChunksFromMask(silent: ArrayLike<boolean>, totalSeconds: number, rule: PauseRule = PAUSE_RULE): Chunk[] {
  const need = Math.round(rule.pauseSeconds / FRAME_SECONDS);
  const out: Chunk[] = [];
  let start = 0;
  while (totalSeconds - start > 1e-9) {
    if (totalSeconds - start <= rule.maxSeconds) {
      out.push({ index: out.length, start, end: totalSeconds });
      break;
    }
    let cut = start + rule.maxSeconds;
    let run = 0;
    const firstFrame = Math.ceil(start / FRAME_SECONDS);
    const lastFrame = Math.min(silent.length, Math.floor((start + rule.maxSeconds) / FRAME_SECONDS));
    for (let f = firstFrame; f < lastFrame; f++) {
      run = silent[f] ? run + 1 : 0;
      if (run >= need && (f + 1) * FRAME_SECONDS >= start + rule.minSeconds) {
        const mid = (f + 1 - run / 2) * FRAME_SECONDS;
        cut = Math.max(start + rule.minSeconds, mid);
        break;
      }
    }
    out.push({ index: out.length, start, end: cut });
    start = cut;
  }
  return out;
}

export function pauseChunks(pcm: Pcm, rule: PauseRule = PAUSE_RULE): Chunk[] {
  const rms = frameRms(pcm);
  const t = silenceThreshold(rms);
  return pauseChunksFromMask(Array.from(rms, (r) => r < t), pcm.samples.length / pcm.rate, rule);
}

export function chunkAudio(pcm: Pcm, mode: ChunkingMode): Chunk[] {
  return mode === "fixed" ? fixedChunks(pcm.samples.length / pcm.rate) : pauseChunks(pcm);
}
