import { fetchAudit, type AuditWireEntry } from "../e2e/audit-read.js";
import { fetchTranscript, findEvents, type TranscriptWireEvent } from "../e2e/transcript-read.js";

export const TARGET = (process.env.E2E_TARGET_URL ?? "").replace(/\/+$/, "");
export const READ = process.env.E2E_CONTROL_READ_TOKEN ?? "";
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rng: () => number, pool: readonly T[]): T {
  return pool[Math.floor(rng() * pool.length) % pool.length];
}

export type InjectionKind = "state" | "probe" | "chatter" | "filler" | "instruction";
export type Addressing = "channel-watch" | "direct-mention";

export interface HarnessMsg {
  readonly text: string;
  readonly author?: string;
  readonly authorId?: string;
}

export interface InjectBody {
  readonly domain: string;
  readonly platform: string;
  readonly surfaceKey: string;
  readonly text?: string;
  readonly addressing?: Addressing;
  readonly origin: Record<string, unknown>;
  readonly mention?: boolean;
  readonly author?: string;
  readonly trust?: "principal" | "peer" | "relay";
  readonly threadTs?: string;
  readonly messages?: readonly HarnessMsg[];
  readonly authAttributes?: Readonly<Record<string, string>>;
}

export interface Injection {
  readonly wakeId: string;
  readonly injectedAt: string;
  readonly kind: InjectionKind;
  readonly tag: string;
  readonly addressing: Addressing;
  readonly platform: string;
  readonly trust: "principal" | "peer" | "relay";
  readonly text: string | null;
}

export async function injectWake(b: InjectBody, kind: InjectionKind, tag: string, log: Injection[]): Promise<Injection> {
  const body: InjectBody = b.platform === "slack"
    ? { ...b, authAttributes: { trust_checked: "true", is_ext_shared: "false", ...(b.authAttributes ?? {}) } }
    : b;
  const res = await fetch(`${TARGET}/control/v1/test/wake`, {
    method: "POST",
    headers: { authorization: `Bearer ${READ}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`inject ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const jb = (await res.json()) as { wakeId: string };
  const coalesced = b.messages && b.messages.length > 0 ? b.messages : null;
  const inj: Injection = {
    wakeId: jb.wakeId,
    injectedAt: new Date().toISOString(),
    kind,
    tag,
    addressing: b.addressing === "direct-mention" ? "direct-mention" : "channel-watch",
    platform: b.platform,
    trust: b.trust ?? "peer",
    text: coalesced ? coalesced[coalesced.length - 1].text : (b.text ?? null),
  };
  log.push(inj);
  return inj;
}

export async function auditSince(sinceIso: string): Promise<readonly AuditWireEntry[]> {
  try {
    return await fetchAudit(TARGET, READ, { sinceIso, limit: 1000 });
  } catch (e) {
    console.warn(`  [audit] ${(e as Error).message}`);
    return [];
  }
}

export const dS = (e: AuditWireEntry, k: string): string | undefined =>
  typeof e.detail?.[k] === "string" ? (e.detail![k] as string) : undefined;
export const dN = (e: AuditWireEntry, k: string): number | undefined =>
  typeof e.detail?.[k] === "number" ? (e.detail![k] as number) : undefined;

export function rowsForWake(rows: readonly AuditWireEntry[], wakeId: string): AuditWireEntry[] {
  return rows.filter((r) => dS(r, "wakeId") === wakeId);
}

const MEMORY_PATH_RE = /(?:^|["'\s(])((?:\/workspace\/)?memory\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)/g;
const PATH_KEYS = new Set(["path", "file_path", "filepath", "filePath", "paths", "files", "command", "cmd", "input"]);

export function normaliseMemoryPath(raw: string): string {
  return raw.replace(/^\/workspace\//, "").replace(/\/+$/, "");
}

function collectPaths(value: unknown, underPathKey: boolean, out: string[]): void {
  if (typeof value === "string") {
    if (!underPathKey) return;
    let m: RegExpExecArray | null;
    MEMORY_PATH_RE.lastIndex = 0;
    while ((m = MEMORY_PATH_RE.exec(value)) !== null) out.push(normaliseMemoryPath(m[1]));
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectPaths(v, underPathKey, out);
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      collectPaths(v, underPathKey || PATH_KEYS.has(k), out);
    }
  }
}

export function extractMemoryPathReads(events: readonly TranscriptWireEvent[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    const t = e.type.toLowerCase();
    if (t.includes("message.received") || t.includes("wake") || t.includes("user")) continue;
    collectPaths(e.data, false, out);
  }
  return out;
}

export function replyText(events: readonly TranscriptWireEvent[]): string | null {
  const out: string[] = [];
  for (const e of events) {
    if (e.type !== "actions.requested") continue;
    const acts = (e.data as { actions?: unknown; calls?: unknown } | null);
    const list = Array.isArray(acts?.actions) ? acts.actions : Array.isArray(acts?.calls) ? acts.calls : [];
    for (const a of list) {
      const name = (a as { toolName?: unknown; name?: unknown }).toolName ?? (a as { name?: unknown }).name;
      const args = ((a as { args?: unknown; input?: unknown }).args ?? (a as { input?: unknown }).input) as { text?: unknown } | undefined;
      if (name === "reply" && typeof args?.text === "string" && args.text.trim().length > 0) out.push(args.text);
    }
  }
  return out.length > 0 ? out.join("\n") : null;
}

export function terminalProse(events: readonly TranscriptWireEvent[]): string | null {
  const msgs = findEvents(events, "message.completed").concat(findEvents(events, "message.delta"));
  let best: string | null = null;
  for (const e of events) {
    const d = e.data as { text?: unknown; content?: unknown; message?: unknown } | null;
    const text =
      typeof d?.text === "string" ? d.text :
      typeof d?.content === "string" ? d.content :
      typeof d?.message === "string" ? d.message : null;
    if (text && text.trim().length > 0) best = text;
  }
  return best ?? (msgs.length > 0 ? "" : null);
}

export async function readTranscript(sessionId: string): Promise<readonly TranscriptWireEvent[]> {
  try {
    const all: TranscriptWireEvent[] = [];
    let start = 0;
    for (let page = 0; page < 20; page++) {
      const r = await fetchTranscript(TARGET, READ, sessionId, { startIndex: start, limit: 10000, idleMs: 2000 });
      all.push(...r.events);
      if (r.complete || r.events.length === 0) break;
      start = r.nextIndex;
    }
    return all;
  } catch (e) {
    console.warn(`  [transcript] ${(e as Error).message}`);
    return [];
  }
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
