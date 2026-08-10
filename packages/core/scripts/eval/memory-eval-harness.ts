import { fetchAudit, type AuditWireEntry } from "../e2e/audit-read.js";
import { fetchTranscript, findEvents, type TranscriptWireEvent } from "../e2e/transcript-read.js";

export const TARGET = (process.env.E2E_TARGET_URL ?? "").replace(/\/+$/, "");
export const READ = process.env.E2E_CONTROL_READ_TOKEN ?? "";
export const INJECT = process.env.E2E_CONTROL_INJECT_TOKEN ?? "";
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
    ? { ...b, authAttributes: { trust_checked: "true", is_ext_shared: "false", user_id: "UE2EMEMLEAD", ...(b.authAttributes ?? {}) } }
    : b;
  const res = await fetch(`${TARGET}/control/v1/test/wake`, {
    method: "POST",
    headers: { authorization: `Bearer ${INJECT}`, "content-type": "application/json" },
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

export { normaliseMemoryPath, extractMemoryPathReads } from "../e2e/memory-reads.js";

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

export function anyStringContains(value: unknown, needle: string): boolean {
  if (typeof value === "string") return value.includes(needle);
  if (Array.isArray(value)) return value.some((v) => anyStringContains(v, needle));
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).some((v) => anyStringContains(v, needle));
  return false;
}

export function transcriptServedWake(events: readonly TranscriptWireEvent[], wakeId: string): boolean {
  if (!wakeId) return false;
  const needle = `wake-id="${wakeId}"`;
  for (const e of events) {
    const t = e.type.toLowerCase();
    if (!(t.includes("message.received") || t.includes("wake") || t.includes("user"))) continue;
    if (anyStringContains(e.data, needle)) return true;
  }
  return false;
}

export type RowAttribution = "wakeId" | "session" | "reject";
export function attributeRow(
  rowWakeId: string | null | undefined,
  rowSessionId: string | null | undefined,
  probeWakeId: string,
  sessionVerified: boolean | null,
): RowAttribution {
  return attributeRowInFamily(rowWakeId, rowSessionId, new Set([probeWakeId]), sessionVerified);
}

export function attributeRowInFamily(
  rowWakeId: string | null | undefined,
  rowSessionId: string | null | undefined,
  familyWakeIds: ReadonlySet<string>,
  sessionVerified: boolean | null,
): RowAttribution {
  if (rowWakeId != null && rowWakeId.length > 0) return familyWakeIds.has(rowWakeId) ? "wakeId" : "reject";
  if (rowSessionId != null && rowSessionId.length > 0) return sessionVerified === true ? "session" : "reject";
  return "reject";
}

export interface DelegationTrace {
  readonly wakeIds: ReadonlySet<string>;
  readonly spawned: readonly string[];
  readonly returned: readonly string[];
  readonly outstanding: readonly string[];
  readonly workerSessionIds: readonly string[];
  readonly lastReturnTs: string | null;
}
export function traceDelegation(rows: readonly AuditWireEntry[], rootWakeId: string): DelegationTrace {
  const wakeIds = new Set<string>([rootWakeId]);
  const spawned: string[] = [];
  const returned: string[] = [];
  const workerSessionIds: string[] = [];
  let lastReturnTs: string | null = null;
  const ordered = [...rows].sort((a, b) => a.ts.localeCompare(b.ts));
  for (let pass = 0; pass < 5; pass++) {
    let grew = false;
    for (const r of ordered) {
      if (r.action !== "task.spawned") continue;
      const parent = dS(r, "parentWakeId");
      const taskId = dS(r, "taskId");
      if (!parent || !wakeIds.has(parent) || !taskId || spawned.includes(taskId)) continue;
      spawned.push(taskId);
      const child = dS(r, "wakeId");
      if (child && !wakeIds.has(child)) wakeIds.add(child);
      grew = true;
    }
    for (const r of ordered) {
      if (r.action !== "task.returned") continue;
      const taskId = dS(r, "taskId");
      if (!taskId || !spawned.includes(taskId)) continue;
      if (!returned.includes(taskId)) { returned.push(taskId); grew = true; }
      const completion = dS(r, "wakeId");
      if (completion && !wakeIds.has(completion)) { wakeIds.add(completion); grew = true; }
      const sid = dS(r, "sessionId");
      if (sid && !workerSessionIds.includes(sid)) { workerSessionIds.push(sid); grew = true; }
      if (lastReturnTs === null || r.ts > lastReturnTs) lastReturnTs = r.ts;
    }
    if (!grew) break;
  }
  return { wakeIds, spawned, returned, outstanding: spawned.filter((t) => !returned.includes(t)), workerSessionIds, lastReturnTs };
}

export const NO_REPLY_ACTIONS: ReadonlySet<string> = new Set(["reply.no_reply", "unified.no_reply"]);
export const REPLIED_ACTIONS: ReadonlySet<string> = new Set(["reply.post", "turn.direct_mention_prose_delivered"]);

export function newTierContent(before: Readonly<Record<string, string>>, after: Readonly<Record<string, string>>): string {
  const parts: string[] = [];
  for (const [path, content] of Object.entries(after)) {
    const prior = before[path];
    if (prior === undefined) { parts.push(content); continue; }
    if (prior === content) continue;
    const priorLines = new Set(prior.split("\n"));
    const added = content.split("\n").filter((ln) => !priorLines.has(ln));
    if (added.length > 0) parts.push(added.join("\n"));
  }
  return parts.join("\n");
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

export { siloOfPath, scoreNavigation, type NavScore } from "../e2e/memory-reads.js";
