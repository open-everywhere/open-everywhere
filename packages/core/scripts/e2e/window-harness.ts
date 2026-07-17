import { fetchAudit, type AuditWireEntry } from "./audit-read.js";
import { fetchTranscript } from "./transcript-read.js";

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export type Status = "PASS" | "SKIP" | "FAIL";
export interface Result { id: string; status: Status; detail: string; }

export function createRecorder(): { results: Result[]; record: (id: string, status: Status, detail: string) => void } {
  const results: Result[] = [];
  const record = (id: string, status: Status, detail: string): void => {
    results.push({ id, status, detail });
    const icon = status === "PASS" ? "✅" : status === "SKIP" ? "⏭ " : "❌";
    console.log(`\n${icon} ${id}: ${status} — ${detail}`);
  };
  return { results, record };
}

export const dS = (e: AuditWireEntry, k: string): string | undefined =>
  (typeof e.detail?.[k] === "string" ? (e.detail[k] as string) : undefined);

export function makeWant(only: string | undefined): (id: string) => boolean {
  const ids = (only ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  return (id: string) => ids.length === 0 || ids.includes(id.toUpperCase());
}

export interface InjectBody {
  domain: string;
  platform: "slack" | "github";
  surfaceKey: string;
  text: string;
  addressing?: string;
  mention?: boolean;
  author?: string;
  origin: Record<string, unknown>;
  threadTs?: string;
  authAttributes?: Record<string, string>;
  soloWindowId?: string;
  taskThread?: string;
}

export interface Injected { wakeId: string; token: string; }

export function createInjector(target: string, readToken: string): (b: InjectBody) => Promise<Injected> {
  return async (b: InjectBody): Promise<Injected> => {
    const res = await fetch(`${target}/control/v1/test/wake`, {
      method: "POST",
      headers: { authorization: `Bearer ${readToken}`, "content-type": "application/json" },
      body: JSON.stringify(b),
    });
    if (!res.ok) throw new Error(`inject ${res.status}: ${(await res.text().catch(() => "")).slice(0, 240)}`);
    const jb = (await res.json()) as { wakeId: string; token: string };
    return { wakeId: jb.wakeId, token: jb.token };
  };
}

export interface AuditReaderOpts {
  readonly onError: "throw" | "swallow";
}

export function createAuditReader(
  target: string,
  readToken: string,
  opts: AuditReaderOpts,
): { rowsSince: (sinceIso: string) => Promise<readonly AuditWireEntry[]>; readFailed: () => boolean } {
  let failed = false;
  const rowsSince = async (sinceIso: string): Promise<readonly AuditWireEntry[]> => {
    try {
      return await fetchAudit(target, readToken, { sinceIso, limit: 600 });
    } catch (e) {
      if (opts.onError === "throw") throw e;
      failed = true;
      console.warn(`  [audit] ${(e as Error).message}`);
      return [];
    }
  };
  return { rowsSince, readFailed: () => failed };
}

export interface ToolCall { name: string; errored: boolean; }

export interface ToolCallsOpts {
  readonly paged?: boolean;
  readonly sinceIso?: string;
}

export async function readToolCalls(
  target: string,
  readToken: string,
  sessionId: string,
  opts: ToolCallsOpts = {},
): Promise<ToolCall[] | null> {
  try {
    const calls: { name: string; errored: boolean; at: string | null }[] = [];
    const byCallId = new Map<string, number>();
    let start = 0;
    for (let page = 0; page < (opts.paged ? 40 : 1); page++) {
      const tr = await fetchTranscript(target, readToken, sessionId, {
        ...(opts.paged ? { startIndex: start } : {}),
        limit: 2000,
        idleMs: 2500,
      });
      for (const e of tr.events) {
        if (e.type === "actions.requested") {
          const acts = (e.data as { actions?: { toolName?: string; callId?: string }[] } | undefined)?.actions ?? [];
          for (const a of acts) {
            if (typeof a.toolName !== "string") continue;
            if (typeof a.callId === "string") byCallId.set(a.callId, calls.length);
            calls.push({ name: a.toolName, errored: false, at: e.at });
          }
        } else if (e.type === "action.result") {
          const d = e.data as { error?: unknown; result?: { callId?: string } } | undefined;
          if (d?.error !== undefined) {
            const idx = byCallId.get(typeof d.result?.callId === "string" ? d.result.callId : "");
            if (idx !== undefined) calls[idx] = { ...calls[idx], errored: true };
          }
        }
      }
      if (!opts.paged) break;
      if (tr.events.length === 0) break;
      start = (tr as { nextIndex?: number }).nextIndex ?? start + tr.events.length;
    }
    const scoped = opts.sinceIso ? calls.filter((c) => c.at === null || c.at >= opts.sinceIso!) : calls;
    return scoped.map(({ name, errored }) => ({ name, errored }));
  } catch (e) {
    console.warn(`  [transcript] ${(e as Error).message}`);
    return null;
  }
}

export async function readToolNames(target: string, readToken: string, sessionId: string): Promise<string[]> {
  try {
    const tr = await fetchTranscript(target, readToken, sessionId, { limit: 2000, idleMs: 2500 });
    const names: string[] = [];
    for (const e of tr.events) {
      if (e.type !== "actions.requested") continue;
      const acts = (e.data as { actions?: { toolName?: string }[] } | undefined)?.actions ?? [];
      for (const a of acts) if (typeof a.toolName === "string") names.push(a.toolName);
    }
    return names;
  } catch { return []; }
}

export async function wholeTranscriptText(
  target: string,
  readToken: string,
  sessionId: string,
): Promise<{ text: string; events: number; complete: boolean }> {
  let startIndex = 0, text = "", events = 0, complete = false, pages = 0;
  while (pages < 30) {
    const tr = await fetchTranscript(target, readToken, sessionId, { startIndex, limit: 10000, idleMs: 3000 });
    for (const e of tr.events) text += "\n" + JSON.stringify(e.data ?? {});
    events += tr.count; complete = tr.complete; startIndex = tr.nextIndex; pages++;
    if (tr.complete || tr.count === 0) break;
  }
  return { text, events, complete };
}

export async function sessionMatrix<T extends { tag: string }>(
  target: string,
  readToken: string,
  sessionIds: Iterable<string>,
  items: readonly T[],
  hooks: {
    onSession?: (sessionId: string, events: number, complete: boolean) => void;
    onHit?: (sessionId: string, item: T) => void;
  } = {},
): Promise<Map<string, string[]>> {
  const tagToSession = new Map<string, string[]>();
  for (const sid of sessionIds) {
    const { text, events, complete } = await wholeTranscriptText(target, readToken, sid);
    hooks.onSession?.(sid, events, complete);
    for (const item of items) {
      if (text.includes(item.tag)) {
        if (!tagToSession.has(item.tag)) tagToSession.set(item.tag, []);
        tagToSession.get(item.tag)!.push(sid);
        hooks.onHit?.(sid, item);
      }
    }
  }
  return tagToSession;
}
