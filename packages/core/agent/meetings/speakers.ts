export interface TranscriptSegment {
  readonly text: string;
  readonly startSecond: number;
  readonly endSecond: number;
}

export interface SpeakerSpan {
  readonly name: string;
  readonly startMs: number;
  readonly endMs: number;
}

export const MAX_NAME_CHARS = 64;
export const MAX_SPANS = 1_000;
export const MAX_ATTENDEES = 100;
export const MAX_SPAN_MS = 10 * 60_000;

export const LABEL_MIN_SHARE = 0.5;
export const RIVAL_MAX_SHARE = 0.25;

export function cleanSpeakerName(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, " ")
    .replace(/[<>[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length === 0) return undefined;
  return s.length > MAX_NAME_CHARS ? s.slice(0, MAX_NAME_CHARS) : s;
}

export function parseSpeakerSpans(v: unknown): SpeakerSpan[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: SpeakerSpan[] = [];
  for (const raw of v.slice(0, MAX_SPANS)) {
    if (raw === null || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const name = cleanSpeakerName(r.name);
    const { startMs, endMs } = r;
    if (name === undefined || typeof startMs !== "number" || typeof endMs !== "number") continue;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs || endMs > MAX_SPAN_MS) continue;
    out.push({ name, startMs, endMs });
  }
  return out;
}

export function parseAttendees(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const raw of v) {
    const name = cleanSpeakerName(raw);
    if (name !== undefined && !out.includes(name)) out.push(name);
    if (out.length >= MAX_ATTENDEES) break;
  }
  return out;
}

export function cleanSegments(v: readonly TranscriptSegment[] | undefined): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  for (const s of v ?? []) {
    if (typeof s?.text !== "string" || s.text.trim().length === 0) continue;
    if (!Number.isFinite(s.startSecond) || !Number.isFinite(s.endSecond) || s.startSecond < 0 || s.endSecond <= s.startSecond) continue;
    out.push({ text: s.text.trim(), startSecond: s.startSecond, endSecond: s.endSecond });
  }
  return out;
}

export function usableSegments(plain: string, segments: readonly TranscriptSegment[] | undefined): TranscriptSegment[] {
  const raw = segments ?? [];
  const clean = cleanSegments(raw);
  if (clean.length === 0 || clean.length !== raw.length) return [];
  const squash = (t: string): string => t.replace(/\s+/g, "");
  return squash(clean.map((x) => x.text).join("")) === squash(plain) ? clean : [];
}

export function speakerFor(seg: TranscriptSegment, spans: readonly SpeakerSpan[]): string | undefined {
  const start = seg.startSecond * 1000;
  const end = seg.endSecond * 1000;
  const length = end - start;
  if (!(length > 0)) return undefined;
  const cover = new Map<string, number>();
  for (const sp of spans) {
    const o = Math.min(end, sp.endMs) - Math.max(start, sp.startMs);
    if (o > 0) cover.set(sp.name, (cover.get(sp.name) ?? 0) + o);
  }
  const ranked = [...cover.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked[0];
  if (top === undefined || top[1] < LABEL_MIN_SHARE * length) return undefined;
  const rival = ranked[1];
  if (rival !== undefined && rival[1] >= RIVAL_MAX_SHARE * length) return undefined;
  return top[0];
}

export interface TranscriptLine {
  readonly speaker?: string;
  readonly text: string;
}

export function labelSegments(segments: readonly TranscriptSegment[], spans: readonly SpeakerSpan[]): TranscriptLine[] {
  const lines: { speaker?: string; text: string }[] = [];
  for (const seg of cleanSegments(segments)) {
    const speaker = speakerFor(seg, spans);
    const last = lines[lines.length - 1];
    if (last !== undefined && last.speaker === speaker) last.text = `${last.text} ${seg.text}`;
    else lines.push({ ...(speaker !== undefined ? { speaker } : {}), text: seg.text });
  }
  return lines;
}

export function renderChunkText(plain: string, lines: readonly TranscriptLine[]): { readonly text: string; readonly labelled: number } {
  const strip = (s: string): string => s.replace(/[[\]]/g, "");
  const labelled = lines.filter((l) => l.speaker !== undefined).length;
  if (labelled === 0) return { text: strip(plain), labelled: 0 };
  return { text: lines.map((l) => (l.speaker !== undefined ? `[${l.speaker}] ${strip(l.text)}` : strip(l.text))).join("\n"), labelled };
}

export const CONTEXT_TAIL_CHARS = 400;
export const MAX_CONTEXT_CHARS = 800;

export function contextTail(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= CONTEXT_TAIL_CHARS) return t;
  const cut = t.slice(t.length - CONTEXT_TAIL_CHARS);
  const space = cut.indexOf(" ");
  return space >= 0 ? cut.slice(space + 1) : cut;
}

export function transcriptionContext(ctx: { readonly previousTail?: string; readonly attendees?: readonly string[] }): string | undefined {
  const tail = contextTail(ctx.previousTail ?? "");
  const room = MAX_CONTEXT_CHARS - tail.length - 1;
  let names = "";
  for (const raw of ctx.attendees ?? []) {
    const n = cleanSpeakerName(raw);
    if (n === undefined) continue;
    const next = names === "" ? `Attendees: ${n}.` : `${names.slice(0, -1)}, ${n}.`;
    if (next.length > room) break;
    names = next;
  }
  const parts = [names, tail].filter((p) => p.length > 0);
  return parts.length > 0 ? parts.join("\n") : undefined;
}
