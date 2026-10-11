export interface RefWord {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly speaker: string;
}

export const AMI_AUDIO_URL = (meeting: string): string =>
  `https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/${meeting}/audio/${meeting}.Mix-Headset.wav`;
export const AMI_ANNOTATIONS_URL = "https://groups.inf.ed.ac.uk/ami/AMICorpusAnnotations/ami_public_manual_1.6.2.zip";
export const AMI_ATTRIBUTION =
  "AMI Meeting Corpus, University of Edinburgh / IDIAP / TNO, CC BY 4.0 (https://groups.inf.ed.ac.uk/ami/corpus/)";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e] ?? m;
  });
}

export function parseAmiWords(xml: string, speaker: string): RefWord[] {
  const out: RefWord[] = [];
  for (const m of xml.matchAll(/<w\s([^>]*)>([^<]*)<\/w>/g)) {
    const attrs = m[1]!;
    if (/\bpunc="true"/.test(attrs)) continue;
    const start = /\bstarttime="([0-9.]+)"/.exec(attrs)?.[1];
    const end = /\bendtime="([0-9.]+)"/.exec(attrs)?.[1];
    if (start === undefined || end === undefined) continue;
    const text = decodeEntities(m[2]!).trim();
    if (text === "") continue;
    out.push({ text, start: Number(start), end: Number(end), speaker });
  }
  return out;
}

export function mergeSpeakers(perSpeaker: readonly RefWord[][]): RefWord[] {
  return perSpeaker.flat().sort((a, b) => a.start - b.start || a.end - b.end);
}

export function wordsInWindow(words: readonly RefWord[], from: number, to: number): RefWord[] {
  return words.filter((w) => w.start >= from && w.start < to);
}
