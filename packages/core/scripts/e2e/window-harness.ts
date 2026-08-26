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
  platform: "slack" | "github" | "discord";
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

export function createInjector(target: string, injectToken: string): (b: InjectBody) => Promise<Injected> {
  return async (b: InjectBody): Promise<Injected> => {
    const res = await fetch(`${target}/control/v1/test/wake`, {
      method: "POST",
      headers: { authorization: `Bearer ${injectToken}`, "content-type": "application/json" },
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

export async function readToolNames(
  target: string,
  readToken: string,
  sessionId: string,
  opts: ToolCallsOpts = {},
): Promise<string[]> {
  return ((await readToolCalls(target, readToken, sessionId, opts)) ?? []).map((c) => c.name);
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

export type DelegationArm = "native-tasks" | "native-sync";

export function delegationArmOf(backgroundTasks: boolean): DelegationArm {
  return backgroundTasks ? "native-tasks" : "native-sync";
}

export interface DelegationEvidence {
  readonly nativeReceipt: boolean;
  readonly replied: boolean;
  readonly calls: readonly { readonly name: string; readonly errored: boolean }[] | null;
  readonly arm: DelegationArm;
}

export interface DelegationVerdict {
  readonly status: Status;
  readonly reason: string;
}

export function classifyDelegationOutcome(ev: DelegationEvidence): DelegationVerdict {
  if (ev.nativeReceipt) {
    return { status: "PASS", reason: "a delegation.task_started row joined this seat's session — the native background-task route dispatched a worker" };
  }
  if (!ev.replied) {
    return { status: "SKIP", reason: "no receipt row and no reply for this wake — the model did not choose to delegate this turn, or the turn is still running" };
  }
  if (ev.calls === null) {
    return { status: "SKIP", reason: "the seat replied but its transcript is UNREADABLE — the delegation outcome is UNVERIFIED (an observability failure, not model behaviour)" };
  }
  const agentCalls = ev.calls.filter((c) => c.name === "agent");
  if (agentCalls.length === 0) {
    return { status: "SKIP", reason: `the seat replied without invoking agent (tools=[${[...new Set(ev.calls.map((c) => c.name))].join(",") || "none"}]) — the model did not choose to delegate this turn` };
  }
  if (agentCalls.some((c) => c.errored)) {
    return { status: "FAIL", reason: "the model CALLED agent and the execute ERRORED — read the action.result error in the transcript; the delegation route is broken, not unchosen" };
  }
  if (ev.arm === "native-sync") {
    return { status: "PASS", reason: "the model called agent and the call did not error — on the native-sync arm (delegation.backgroundTasks off) no receipt row exists, so a clean call IS the receipt" };
  }
  return {
    status: "FAIL",
    reason: `the model called agent, the call did NOT error, and yet no delegation.task_started (joined on the caller session) row landed — the dispatch leg is broken on the ${ev.arm} arm`,
  };
}

export interface WithheldVerdict {
  readonly ok: boolean;
  readonly missing: readonly string[];
  readonly cutKeep: readonly string[];
  readonly surplus: readonly string[];
}

export function scoreWithheld(live: readonly string[], manifestWithheld: readonly string[], mustKeep: readonly string[]): WithheldVerdict {
  const set = new Set(live);
  const missing = manifestWithheld.filter((n) => !set.has(n)).sort();
  const cutKeep = mustKeep.filter((n) => set.has(n)).sort();
  const manifest = new Set(manifestWithheld);
  const surplus = live.filter((n) => !manifest.has(n)).sort();
  return { ok: missing.length === 0 && cutKeep.length === 0, missing, cutKeep, surplus };
}

export function scoreWithheldPair(grainLive: readonly string[], leanLive: readonly string[], manifestWithheld: readonly string[], mustKeep: readonly string[]): WithheldVerdict {
  const grainSet = new Set(grainLive);
  const leanSet = new Set(leanLive);
  const missing = manifestWithheld.filter((n) => !grainSet.has(n)).sort();
  const cutKeep = mustKeep.filter((n) => leanSet.has(n)).sort();
  const manifest = new Set(manifestWithheld);
  const surplus = leanLive.filter((n) => !manifest.has(n)).sort();
  return { ok: missing.length === 0 && cutKeep.length === 0, missing, cutKeep, surplus };
}
