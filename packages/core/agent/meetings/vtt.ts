import type { NativeTranscriptSegment } from "./native.js";

const TIMING = /^(?:(\d{1,3}):)?(\d{2}):(\d{2})[.,](\d{3})\s+-->\s+/;
const VOICE = /<v(?:\.[^\s>]*)?\s+([^>]*)>/;
const NAME_PREFIX = /^([^:\n]{1,80}):\s+(.+)$/s;

function startMs(line: string): number | undefined {
  const m = TIMING.exec(line);
  if (m === null) return undefined;
  return (((Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000) + Number(m[4]);
}

export function parseWebVtt(doc: string, opts: { readonly namePrefix?: boolean } = {}): NativeTranscriptSegment[] {
  const out: NativeTranscriptSegment[] = [];
  const blocks = doc.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n");
    const timingAt = lines.findIndex((l) => TIMING.test(l));
    if (timingAt < 0) continue;
    const at = startMs(lines[timingAt]!);
    const raw = lines.slice(timingAt + 1).join(" ").trim();
    if (raw.length === 0) continue;
    let speaker = "";
    const voice = VOICE.exec(raw);
    if (voice !== null) speaker = voice[1]!.trim();
    let text = raw.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
    if (speaker === "" && opts.namePrefix === true) {
      const m = NAME_PREFIX.exec(text);
      if (m !== null) {
        speaker = m[1]!.trim();
        text = m[2]!.trim();
      }
    }
    if (text.length === 0) continue;
    out.push({ speaker, text, ...(at !== undefined ? { startMs: at } : {}) });
  }
  return out;
}
