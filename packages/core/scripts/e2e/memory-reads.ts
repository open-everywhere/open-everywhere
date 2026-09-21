import { isToolResultEvent, type TranscriptWireEvent } from "./transcript-read.js";

const MEMORY_PATH_RE =
  /(?:^|["'\s(])((?:\/workspace\/)?memory\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*|\/workspace\/memory|memory\/)(?![A-Za-z0-9._-])/g;
const MEMORY_FILE_RE = /(?:^|["'\s(])((?:\/workspace\/)?memory\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+)(?![A-Za-z0-9._-])/g;
const PATH_KEYS = new Set(["path", "file_path", "filepath", "filePath", "paths", "files", "command", "cmd", "input"]);
const PROSE_KEYS = new Set(["brief", "prompt", "instructions", "message", "text"]);
const RESULT_PROSE_KEYS = new Set(["brief", "prompt", "instructions"]);

export function normaliseMemoryPath(raw: string): string {
  return raw.replace(/^\/workspace\//, "").replace(/\/+$/, "");
}

interface ReadArm {
  readonly re: RegExp;
  readonly denied: ReadonlySet<string>;
}
const INPUT_ARM: ReadArm = { re: MEMORY_PATH_RE, denied: PROSE_KEYS };
const RESULT_ARM: ReadArm = { re: MEMORY_FILE_RE, denied: RESULT_PROSE_KEYS };

function collectPaths(value: unknown, underPathKey: boolean, out: string[], arm: ReadArm): void {
  if (typeof value === "string") {
    if (!underPathKey) return;
    let m: RegExpExecArray | null;
    arm.re.lastIndex = 0;
    while ((m = arm.re.exec(value)) !== null) out.push(normaliseMemoryPath(m[1]));
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectPaths(v, underPathKey, out, arm);
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      collectPaths(v, !arm.denied.has(k) && (underPathKey || PATH_KEYS.has(k)), out, arm);
    }
  }
}

export function extractMemoryPathReads(events: readonly TranscriptWireEvent[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    const t = e.type.toLowerCase();
    if (t.includes("message.received") || t.includes("wake") || t.includes("user")) continue;
    const isResult = isToolResultEvent(t);
    const found: string[] = [];
    collectPaths(e.data, isResult, found, isResult ? RESULT_ARM : INPUT_ARM);
    for (const p of new Set(found)) out.push(p);
  }
  return out;
}

export function siloOfPath(p: string): string | null {
  const m = /^memory\/([A-Za-z0-9._-]+)/.exec(p);
  return m ? m[1] : null;
}

export interface NavScore {
  readonly rightSiloFirst: boolean;
  readonly readsToHit: number | null;
  readonly crossSiloConfusion: boolean;
  readonly silosTouched: string[];
  readonly totalReads: number;
}

export function scoreNavigation(reads: readonly string[], correctSilo: string, answerPath: string): NavScore {
  const silos = reads.map(siloOfPath).filter((s): s is string => s !== null);
  const silosTouched: string[] = [];
  for (const s of silos) if (!silosTouched.includes(s)) silosTouched.push(s);
  const answerNorm = normaliseMemoryPath(answerPath);
  const hitIdx = reads.findIndex((r) => normaliseMemoryPath(r) === answerNorm || answerNorm.endsWith(r) || r.endsWith(answerNorm));
  return {
    rightSiloFirst: silos.length > 0 && silos[0] === correctSilo,
    readsToHit: hitIdx >= 0 ? hitIdx : null,
    crossSiloConfusion: silos.some((s) => s !== correctSilo),
    silosTouched,
    totalReads: reads.length,
  };
}
