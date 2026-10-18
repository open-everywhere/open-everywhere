import type { AuditWireEntry } from "./audit-read.js";
import type { TranscriptWireEvent } from "./transcript-read.js";
import { WAKE_INGRESS_ACTION, WAKE_TURN_START_ACTION } from "../../agent/channels/wake-timing.js";
import type { MemoryPersistOutcome } from "../../agent/hooks/memory.js";
import type { MemoryWriteRoad } from "../../agent/memory/write-road.js";
import {
  DELEGATION_TASK_SETTLED_ACTION,
  DELEGATION_TASK_STARTED_ACTION,
  forwardedJobsDispatchedAtOrAfter,
  REPLY_EDIT_ACTION,
  tasksDispatchedAtOrAfter,
  WORK_FORWARDED_ACTION,
  wakeLineage,
} from "./read-channel-lib.js";
import { carriesFactToken } from "./journey.js";

function dstr(row: AuditWireEntry, key: string): string | undefined {
  const v = row.detail?.[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function tsMs(row: AuditWireEntry): number {
  return Date.parse(row.ts);
}

export const AUDIT_SINCE_SKEW_MS = 5_000;

export function auditSinceForVendorInstant(vendorMs: number, marginMs: number = AUDIT_SINCE_SKEW_MS): string {
  return new Date(vendorMs - marginMs).toISOString();
}

export function auditSinceForDriverClock(nowMs: number, marginMs: number = AUDIT_SINCE_SKEW_MS): string {
  return new Date(nowMs - marginMs).toISOString();
}

const SALT_ALPHABET = "bcdfghjkmnpqrstvwxz";

const SALT_LENGTH = 6;

export function fixtureSalt(random: () => number = Math.random): string {
  let out = "";
  for (let i = 0; i < SALT_LENGTH; i++) out += SALT_ALPHABET[Math.floor(random() * SALT_ALPHABET.length) % SALT_ALPHABET.length];
  return out;
}

export function saltedFixtureLine(text: string, salt: string): string {
  return salt.length === 0 ? text : `${text} (ref ${salt})`;
}

export function carriesHostTemplate(text: string, templates: readonly string[]): boolean {
  return templates.some((t) => t.length > 0 && text.includes(t));
}

export const PROMISE_SUBJECT = "(?:\\b(?:i|we)(?:['’]ll|\\s+will)|(?:\\b(?:and|then)\\s+|[;:,—–]\\s*|(?:^|\\n)\\s*)will)";

export const MEMORY_WRITE_ACTION = "memory.write";

export const MEMORY_OWN_PERSIST_ROADS: readonly string[] = ["session-persist"];

export function isMemoryHopWrite(row: AuditWireEntry): boolean {
  if (row.action !== MEMORY_WRITE_ACTION) return false;
  const road = dstr(row, "road");
  if (road === undefined) return true;
  return !MEMORY_OWN_PERSIST_ROADS.includes(road) && !MEMORY_BACKGROUND_ROADS.includes(road);
}

export const MEMORY_BACKGROUND_ROADS: readonly string[] = ["dream-learn", "dream-tidy"] satisfies readonly MemoryWriteRoad[];

export function isMemoryDeferredWrite(row: AuditWireEntry): boolean {
  if (row.action !== MEMORY_WRITE_ACTION) return false;
  const road = dstr(row, "road");
  return road !== undefined && MEMORY_BACKGROUND_ROADS.includes(road);
}

export type SharedContextRead =
  | { readonly kind: "held" }
  | { readonly kind: "hop"; readonly paths: readonly string[] }
  | { readonly kind: "not-located" }
  | { readonly kind: "not-run" };

export function sharedContextVerdict(
  memoryWrites: readonly AuditWireEntry[],
  read: SharedContextRead,
): { readonly pass: boolean; readonly text: string } {
  const hops = memoryWrites.filter((r) => isMemoryHopWrite(r));
  const deferred = memoryWrites.filter((r) => isMemoryDeferredWrite(r));
  const seen = `${memoryWrites.length} memory.write row(s) in the decide→reply window`;
  if (hops.length > 0) {
    return {
      pass: false,
      text:
        `shared-context proof (write side): ${hops.length} memory write(s) on a road other than \`session-persist\` or a background dream road — a hop. ` +
        `${seen}: ${JSON.stringify(hops.map((r) => r.detail))}`,
    };
  }
  if (deferred.length === 0) {
    return {
      pass: true,
      text:
        `shared-context proof (write side): no memory write on a road other than \`session-persist\` (${seen}). Every session's \`session-persist\` row is excluded ` +
        "because that road carries the turn-end persist AND the remember-ask flush alike — the READ side is what sees a hop taken on it",
    };
  }
  const rows = JSON.stringify(deferred.map((r) => r.detail));
  switch (read.kind) {
    case "held":
      return { pass: true, text: `shared-context proof (write side): UNDECIDED by ${deferred.length} background dream write(s) (${rows}); the READ side decided it — the GitHub turn read no memory path` };
    case "hop":
      return { pass: false, text: `shared-context proof (write side): UNDECIDED by ${deferred.length} background dream write(s) (${rows}); the READ side found ${read.paths.length} memory read(s) in the GitHub turn — a hop` };
    case "not-located":
    case "not-run":
      return {
        pass: false,
        text:
          `shared-context proof UNPROVEN: ${deferred.length} background dream write(s) in the window (${rows}) leave the write side undecided, and the read side was ` +
          `${read.kind === "not-located" ? "NOT LOCATED" : "NOT RUN"}, so nothing shows the GitHub answer came from the live window`,
      };
  }
}

export interface ReplayedEvent {
  readonly index: number;
  readonly type: string;
  readonly data: unknown;
}

export interface MemoryReadSlice {
  readonly fromIndex?: number;
  readonly toIndex?: number;
  readonly paths: readonly string[];
  readonly bounded: boolean;
}

export const WAKE_ENVELOPE_EVENT = "message.received";

export function decodeEnvelopeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function envelopeText(e: ReplayedEvent): string {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v !== null && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(e.data);
  return decodeEnvelopeEntities(out.join("\n"));
}

export function memoryPathReadsBetween(
  events: readonly ReplayedEvent[],
  opts: {
    readonly fromText: string;
    readonly fromWakeId?: string;
    readonly toText: string;
    readonly extractPaths: (events: readonly ReplayedEvent[]) => readonly string[];
  },
): MemoryReadSlice {
  const opens = (e: ReplayedEvent): boolean => {
    if (e.type !== WAKE_ENVELOPE_EVENT) return false;
    const text = envelopeText(e);
    if (opts.fromWakeId !== undefined && opts.fromWakeId.length > 0) return text.includes(`wake-id="${opts.fromWakeId}"`);
    return opts.fromText.length > 0 && text.includes(opts.fromText);
  };
  let fromIndex: number | undefined;
  let toIndex: number | undefined;
  for (const e of events) {
    if (opens(e)) {
      fromIndex = e.index;
      continue;
    }
    if (fromIndex === undefined || e.type === WAKE_ENVELOPE_EVENT) continue;
    if (e.index > fromIndex && opts.toText.length > 0 && JSON.stringify({ type: e.type, data: e.data }).includes(opts.toText)) {
      toIndex = e.index;
      break;
    }
  }
  if (fromIndex === undefined || toIndex === undefined) {
    return { ...(fromIndex !== undefined ? { fromIndex } : {}), ...(toIndex !== undefined ? { toIndex } : {}), paths: [], bounded: false };
  }
  const opened = fromIndex;
  const closed = toIndex;
  const inside = events.filter((e) => e.index > opened && e.index <= closed);
  return { fromIndex, toIndex, paths: [...opts.extractPaths(inside)], bounded: true };
}

export const SETTLEMENT_REPORT_POSTED_ACTION = "delegation.settlement_report_posted";

export const REPLY_POST_ACTION = "reply.post";

export interface SettlementReportPairing {
  readonly id: string;
  readonly task: string;
  readonly wake: string;
}

export function settlementReportPairings(rows: readonly AuditWireEntry[]): readonly SettlementReportPairing[] {
  const out: SettlementReportPairing[] = [];
  for (const settled of rows) {
    if (settled.action !== SETTLEMENT_REPORT_POSTED_ACTION) continue;
    const wake = dstr(settled, "wake");
    const task = dstr(settled, "task");
    if (wake === undefined || task === undefined) continue;
    let best: { readonly id: string; readonly key: number } | undefined;
    for (const post of rows) {
      if (post.action !== REPLY_POST_ACTION) continue;
      if (dstr(post, "wakeId") !== wake) continue;
      const id = dstr(post, "id");
      if (id === undefined) continue;
      const pair =
        typeof settled.seq === "number" && typeof post.seq === "number"
          ? { at: post.seq, limit: settled.seq }
          : { at: tsMs(post), limit: tsMs(settled) };
      if (!Number.isFinite(pair.at) || !Number.isFinite(pair.limit) || pair.at > pair.limit) continue;
      if (best === undefined || pair.at > best.key) best = { id, key: pair.at };
    }
    if (best !== undefined) out.push({ id: best.id, task, wake });
  }
  return out;
}

export type SettlementReplyVerdict =
  | { readonly kind: "not-a-report"; readonly detail: string }
  | { readonly kind: "answer"; readonly wakeId: string; readonly detail: string }
  | { readonly kind: "step-over"; readonly detail: string };

export function replyPostWakeId(rows: readonly AuditWireEntry[], messageId: string): string | undefined {
  for (const r of rows) {
    if (r.action !== REPLY_POST_ACTION) continue;
    if (dstr(r, "id") !== messageId) continue;
    const wake = dstr(r, "wakeId");
    if (wake !== undefined) return wake;
  }
  return undefined;
}

export function turnStartMs(rows: readonly AuditWireEntry[], wakeId: string): number | undefined {
  for (const r of rows) {
    if (r.action !== WAKE_TURN_START_ACTION) continue;
    if (dstr(r, "wakeId") !== wakeId) continue;
    const at = tsMs(r);
    if (Number.isFinite(at)) return at;
  }
  return undefined;
}

export function classifySettlementReply(
  rows: readonly AuditWireEntry[],
  opts: {
    readonly messageId: string;
    readonly askWakeId: string | undefined;
    readonly floorMs: number | undefined;
    readonly answersAsk: boolean;
  },
): SettlementReplyVerdict {
  const pairing = settlementReportPairings(rows).find((p) => p.id === opts.messageId);
  if (pairing === undefined) {
    return { kind: "not-a-report", detail: `no ${SETTLEMENT_REPORT_POSTED_ACTION} row names message ${opts.messageId}` };
  }
  const postedBy = replyPostWakeId(rows, opts.messageId);
  const missing =
    opts.askWakeId === undefined
      ? `this read holds no ${WAKE_INGRESS_ACTION} row for the ask itself`
      : opts.floorMs === undefined
        ? `this read holds no ${WAKE_TURN_START_ACTION} row for the ask's wake ${opts.askWakeId}, so its turn has no floor`
        : postedBy === undefined
          ? `no ${REPLY_POST_ACTION} row names the wake that posted it`
          : undefined;
  if (opts.askWakeId === undefined || opts.floorMs === undefined || postedBy === undefined) {
    return {
      kind: "step-over",
      detail: `message ${opts.messageId} carried the SETTLEMENT REPORT of task ${pairing.task}, and ${missing} — it cannot be tied to this ask, so it is stepped over (OPE-1965)`,
    };
  }
  const rewrite = rewriteAfterReport(rows, opts.messageId, pairing);
  if (rewrite !== undefined) {
    const lineage = wakeLineage(rows, opts.askWakeId, opts.floorMs);
    if (rewrite.wake === undefined || !lineage.has(rewrite.wake)) {
      return {
        kind: "step-over",
        detail:
          `message ${opts.messageId} carried the SETTLEMENT REPORT of task ${pairing.task} and was then rewritten in place ` +
          (rewrite.wake === undefined
            ? `by a ${REPLY_EDIT_ACTION} row that names no wake`
            : `under wake ${rewrite.wake}, which is OUTSIDE the ask's own lineage (ask wake ${opts.askWakeId})`) +
          " — the edit cannot be tied to this ask (OPE-2127)",
      };
    }
    if (!opts.answersAsk) {
      return {
        kind: "step-over",
        detail:
          `message ${opts.messageId} carried the SETTLEMENT REPORT of task ${pairing.task} and was then rewritten in place under ` +
          `wake ${rewrite.wake} on the ask's own lineage, but its text does not carry what the ask asked for (OPE-2127)`,
      };
    }
    return {
      kind: "answer",
      wakeId: rewrite.wake,
      detail:
        `message ${opts.messageId} first carried the SETTLEMENT REPORT of task ${pairing.task}, and was then rewritten in place under ` +
        `wake ${rewrite.wake} on the ask's own lineage — the edited text carries what the ask asked for, so the edit is the ANSWER (OPE-2127)`,
    };
  }
  if (!tasksDispatchedAtOrAfter(rows, opts.floorMs).has(pairing.task) && !forwardedJobsDispatchedAtOrAfter(rows, opts.floorMs).has(pairing.task)) {
    return {
      kind: "step-over",
      detail:
        `message ${opts.messageId} carried the SETTLEMENT REPORT of task ${pairing.task}, which has no ${DELEGATION_TASK_STARTED_ACTION} ` +
        `row inside the ask's own turn — a PREVIOUS leg dispatched it and it settled in this turn (OPE-1965)`,
    };
  }
  const lineage = wakeLineage(rows, opts.askWakeId, opts.floorMs);
  if (!lineage.has(postedBy)) {
    return {
      kind: "step-over",
      detail:
        `message ${opts.messageId} carried a SETTLEMENT REPORT posted under wake ${postedBy}, which is OUTSIDE the ask's own ` +
        `lineage (ask wake ${opts.askWakeId}) — this ask dispatched task ${pairing.task}, but the wake that posted is not one it answers under`,
    };
  }
  if (!opts.answersAsk) {
    return {
      kind: "step-over",
      detail:
        `message ${opts.messageId} carried the SETTLEMENT REPORT of task ${pairing.task}, which this ask dispatched, but its text does ` +
        "not carry what the ask asked for — the caller's content gate rejected it (a fan-out settles more than one task in a turn)",
    };
  }
  return {
    kind: "answer",
    wakeId: postedBy,
    detail:
      `message ${opts.messageId} carried the SETTLEMENT REPORT of task ${pairing.task}, which THIS ask dispatched, posted under wake ` +
      `${postedBy}${postedBy === opts.askWakeId ? "" : ", minted for that task"}, and it carries what the ask asked for — the delegated ANSWER (OPE-1988)`,
  };
}

function rewriteAfterReport(
  rows: readonly AuditWireEntry[],
  messageId: string,
  pairing: SettlementReportPairing,
): { readonly row: AuditWireEntry; readonly wake: string | undefined } | undefined {
  const settled = rows.find((r) => r.action === SETTLEMENT_REPORT_POSTED_ACTION && dstr(r, "task") === pairing.task && dstr(r, "wake") === pairing.wake);
  if (settled === undefined) return undefined;
  let newest: AuditWireEntry | undefined;
  for (const r of rows) {
    if (r.action !== REPLY_EDIT_ACTION || dstr(r, "id") !== messageId) continue;
    const after = positionCompare(r, settled);
    if (after === undefined || after <= 0) continue;
    if (newest === undefined || (positionCompare(r, newest) ?? 0) > 0) newest = r;
  }
  return newest === undefined ? undefined : { row: newest, wake: dstr(newest, "wakeId") };
}

export function replyPostSessionId(rows: readonly AuditWireEntry[], messageId: string): string | undefined {
  for (const r of rows) {
    if (r.action !== REPLY_POST_ACTION) continue;
    if (dstr(r, "id") !== messageId) continue;
    const session = dstr(r, "sessionId");
    if (session !== undefined) return session;
  }
  return undefined;
}

export const CONNECTOR_USE_ACTION = "connector.use";

export type ConnectorRoad =
  | "personal"
  | "org-connector"
  | "unknown";

export function classifyConnectorRoad(rows: readonly AuditWireEntry[], connector: string): ConnectorRoad {
  let newest: { readonly row: AuditWireEntry; readonly at: number } | undefined;
  for (const r of rows) {
    if (r.action !== CONNECTOR_USE_ACTION) continue;
    if (dstr(r, "connection") !== connector) continue;
    const at = tsMs(r);
    const key = Number.isFinite(at) ? at : 0;
    if (newest === undefined || key > newest.at) newest = { row: r, at: key };
  }
  if (newest === undefined) return "unknown";
  if (dstr(newest.row, "grant") === "work-surface") return "org-connector";
  const mode = dstr(newest.row, "mode");
  if (mode === "dm") return "personal";
  if (mode === undefined) return "unknown";
  return "org-connector";
}

export const FIRE_ATTRS_SENT_ACTION = "routine.fire_attrs_sent";

export interface FireAnchor {
  readonly atIso: string;
  readonly atMs: number;
  readonly routineId?: string;
  readonly wakeId?: string;
}

export function fireAnchor(rows: readonly AuditWireEntry[], opts: { readonly postedAtMs?: number } = {}): FireAnchor | undefined {
  let best: { readonly row: AuditWireEntry; readonly at: number } | undefined;
  for (const r of rows) {
    if (r.action !== FIRE_ATTRS_SENT_ACTION) continue;
    const at = tsMs(r);
    if (!Number.isFinite(at)) continue;
    if (opts.postedAtMs !== undefined && at > opts.postedAtMs) continue;
    if (best === undefined || at > best.at) best = { row: r, at };
  }
  if (best === undefined) return undefined;
  const routineId = dstr(best.row, "routineId");
  const wakeId = dstr(best.row, "wakeId");
  return {
    atIso: new Date(best.at).toISOString(),
    atMs: best.at,
    ...(routineId !== undefined ? { routineId } : {}),
    ...(wakeId !== undefined ? { wakeId } : {}),
  };
}

export function rowsAtOrAfter(rows: readonly AuditWireEntry[], atMs: number): readonly AuditWireEntry[] {
  return rows.filter((r) => {
    const at = tsMs(r);
    return !Number.isFinite(at) || at >= atMs;
  });
}

export const WORKER_TOOLSET_ACTION = "worker.toolset";

export interface WorkerRoadVerdict {
  readonly workers: number;
  readonly mounted: boolean;
  readonly explained: number;
  readonly sample: readonly string[];
}

const ROSTER_SAMPLE = 12;

export function workerRoadForOp(rows: readonly AuditWireEntry[], op: string): WorkerRoadVerdict {
  let workers = 0;
  let mounted = false;
  let explained = 0;
  let sample: readonly string[] = [];
  for (const r of rows) {
    if (r.action !== WORKER_TOOLSET_ACTION) continue;
    workers += 1;
    const raw = r.detail?.tools;
    const readable = Array.isArray(raw) && raw.every((t) => typeof t === "string") && r.detail?.namesTruncated !== true;
    const tools = Array.isArray(raw) ? raw.filter((t): t is string => typeof t === "string") : [];
    if (tools.includes(op)) {
      mounted = true;
      continue;
    }
    if (!readable) continue;
    explained += 1;
    if (sample.length === 0 && tools.length > 0) sample = tools.slice(0, ROSTER_SAMPLE);
  }
  return { workers, mounted, explained, sample };
}

export type UnattendedArmVerdict =
  | "measured"
  | "not-proven"
  | "unexplained";

export interface UnattendedArmRoad {
  readonly verdict: UnattendedArmVerdict;
  readonly note: string;
  readonly road: WorkerRoadVerdict;
}

export const FIRE_ATTRS_SEEN_ACTION = "routine.fire_attrs_seen";

export function fireSessionIds(rows: readonly AuditWireEntry[]): readonly string[] {
  const ids = new Set<string>();
  for (const r of rows) {
    if (r.action !== FIRE_ATTRS_SEEN_ACTION) continue;
    const id = dstr(r, "sessionId");
    if (id !== undefined && id.length > 0) ids.add(id);
  }
  return [...ids];
}

export function workerRowsOfFire(rows: readonly AuditWireEntry[], fireSessions: readonly string[]): readonly AuditWireEntry[] {
  const fire = new Set(fireSessions);
  return rows.filter((r) => {
    if (r.action !== WORKER_TOOLSET_ACTION) return false;
    const parent = dstr(r, "parentSession");
    const root = dstr(r, "rootSession");
    return (parent !== undefined && fire.has(parent)) || (root !== undefined && fire.has(root));
  });
}

export function workerSessionIdsOfFire(rows: readonly AuditWireEntry[], fireSessions: readonly string[]): readonly string[] {
  const ids = new Set<string>();
  for (const r of workerRowsOfFire(rows, fireSessions)) {
    const id = dstr(r, "worker");
    if (id !== undefined && id.length > 0) ids.add(id);
  }
  return [...ids];
}

export const CONNECTION_SEARCH_TOOL = "connection_search";

export interface FireOpCalls {
  readonly discovered: boolean;
  readonly called: boolean;
}

export function fireOpCalls(events: readonly TranscriptWireEvent[], op: string): FireOpCalls {
  let discovered = false;
  let called = false;
  for (const e of events) {
    if (e.type === "actions.requested") {
      const actions = (e.data as { actions?: unknown } | null)?.actions;
      if (!Array.isArray(actions)) continue;
      if (actions.some((a) => (a as { toolName?: unknown } | null)?.toolName === op)) called = true;
    } else if (e.type === "action.result") {
      const result = (e.data as { result?: { toolName?: unknown; output?: unknown } } | null)?.result;
      if (result?.toolName !== CONNECTION_SEARCH_TOOL) continue;
      if (JSON.stringify(result.output ?? null).includes(op)) discovered = true;
    }
  }
  return { discovered, called };
}

const NOTION_REST_SKILL = "notion-rest";
const NOTION_REST_SCRIPT = "notion.mjs";

export function transcriptTookRestRoad(events: readonly TranscriptWireEvent[]): boolean {
  for (const e of events) {
    if (e.type !== "actions.requested") continue;
    const actions = (e.data as { actions?: unknown } | null)?.actions;
    if (!Array.isArray(actions)) continue;
    for (const action of actions as { toolName?: unknown; input?: unknown }[]) {
      const input = JSON.stringify(action?.input ?? null);
      if (action?.toolName === "load_skill" && input.includes(NOTION_REST_SKILL)) return true;
      if (action?.toolName === "bash" && input.includes(NOTION_REST_SCRIPT)) return true;
    }
  }
  return false;
}

export interface ArmSessionTranscript {
  readonly sessionId: string;
  readonly role: "fire" | "worker";
  readonly events: readonly TranscriptWireEvent[];
}

export interface ArmOpCalls {
  readonly discoveredBy: readonly string[];
  readonly calledBy: readonly string[];
  readonly restBy: readonly string[];
}

export function armOpCalls(transcripts: readonly ArmSessionTranscript[], op: string): ArmOpCalls {
  const discoveredBy: string[] = [];
  const calledBy: string[] = [];
  const restBy: string[] = [];
  for (const t of transcripts) {
    const who = `${t.role} ${t.sessionId}`;
    const calls = fireOpCalls(t.events, op);
    if (calls.discovered) discoveredBy.push(who);
    if (calls.called) calledBy.push(who);
    if (transcriptTookRestRoad(t.events)) restBy.push(who);
  }
  return { discoveredBy, calledBy, restBy };
}

export function attendedRowsForOp(rows: readonly AuditWireEntry[], op: string): readonly AuditWireEntry[] {
  return rows.filter((r) => {
    if (r.action !== "approval.requested" && r.action !== "approval.chain") return false;
    const kind = dstr(r, "kind");
    return dstr(r, "tool") === op || (kind !== undefined && kind.includes(op));
  });
}

export function unattendedArmRoad(args: {
  readonly planeRows: number;
  readonly workerRows: readonly AuditWireEntry[];
  readonly fireSessions: readonly string[];
  readonly op: string;
  readonly transcripts?: readonly ArmSessionTranscript[];
  readonly attendedRows?: number;
}): UnattendedArmRoad {
  const road = workerRoadForOp(workerRowsOfFire(args.workerRows, args.fireSessions), args.op);
  const fires = `fire session(s) ${JSON.stringify(args.fireSessions)}`;
  const calls = armOpCalls(args.transcripts ?? [], args.op);
  const attended = args.attendedRows ?? 0;
  const seen: string[] = [];
  if (calls.calledBy.length === 0 && calls.discoveredBy.length > 0) {
    seen.push(`${calls.discoveredBy.join(", ")} discovered the op (${CONNECTION_SEARCH_TOOL} returned ${args.op}) and no session called it`);
  }
  if (calls.restBy.length > 0) seen.push(`${calls.restBy.join(", ")} took the REST road (loaded the ${NOTION_REST_SKILL} skill or ran its ${NOTION_REST_SCRIPT} script)`);
  const transcriptClause = seen.length === 0 ? "" : `; the transcripts say: ${seen.join("; ")}`;
  const rosterNote =
    road.workers === 0
      ? args.planeRows === 0
        ? calls.discoveredBy.length > 0
          ? `the fire discovered the op (${CONNECTION_SEARCH_TOOL} returned ${args.op}) and made no op call, and delegated to no worker — the road was open and the fire did not take it (${fires})`
          : `the fire called no connector tool and delegated to no worker (${fires})`
        : `the fire delegated to no worker (${fires})`
      : road.mounted
        ? `${road.workers} worker(s) of the fire ran and at least one MOUNTED ${args.op}, so the connector road was open to the work (${fires})${transcriptClause}`
        : road.explained === 0
          ? `${road.workers} worker(s) of the fire ran, none mounted ${args.op}, and NO roster could be read whole (a non-array tools list, or one the emitter truncated) — an unreadable roster cannot say which road the seat took (${fires})${transcriptClause}`
          : `NO CONNECTOR CALL HAPPENED: ${road.workers} worker(s) of the fire ran and none mounted ${args.op} (one roster: ${JSON.stringify(road.sample)}) — the fire took another road, so the fence was never on it (${fires})${transcriptClause}`;
  const note =
    args.fireSessions.length === 0
      ? `no ${FIRE_ATTRS_SEEN_ACTION} row in this window names the fire's session, so no worker roster can be attributed to the fire`
      : args.planeRows === 0 && attended > 0
        ? `ATTENDED PATH, A PRODUCT FINDING: ${attended} approval.requested/approval.chain row(s) name ${args.op} and the connector plane carries no fence row — the call took the card path instead of connector.refused (ask-unattended) or connector.unattended_lift, so the fire's unattended mark did not reach the session that called. This is not "no road" (${fires})`
        : args.planeRows === 0 && calls.calledBy.length > 0
          ? `${calls.calledBy.join(", ")} CALLED ${args.op} and the connector plane carries no row for it — the fence was on the road and recorded nothing (${fires})`
          : rosterNote;
  const verdict: UnattendedArmVerdict =
    args.planeRows > 0 ? "measured" : attended > 0 || calls.calledBy.length > 0 ? "unexplained" : !road.mounted && road.explained > 0 ? "not-proven" : "unexplained";
  return { verdict, note, road };
}

export function wakeIdForVendorInstant(rows: readonly AuditWireEntry[], vendorMs: number, surfaceKey?: string): string | undefined {
  for (const r of rows) {
    if (r.action !== WAKE_INGRESS_ACTION) continue;
    if (surfaceKey !== undefined && dstr(r, "surfaceKey") !== surfaceKey) continue;
    const vendorTs = dstr(r, "vendorTs");
    if (vendorTs === undefined || Date.parse(vendorTs) !== vendorMs) continue;
    const wakeId = dstr(r, "wakeId");
    if (wakeId !== undefined) return wakeId;
  }
  return undefined;
}

export const UNACCOUNTED_WAKES_ACTION = "turn.unaccounted_wakes";

export type UnansweredWakeVerdict =
  | { readonly kind: "ambient-silence"; readonly detail: string }
  | { readonly kind: "addressed-silence"; readonly detail: string }
  | { readonly kind: "unknown"; readonly detail: string };

export function classifyUnansweredWake(rows: readonly AuditWireEntry[], wakeId: string): UnansweredWakeVerdict {
  for (const r of rows) {
    if (r.action !== UNACCOUNTED_WAKES_ACTION) continue;
    if (dstr(r, "turnWake") !== wakeId) continue;
    const raw = r.detail?.unaccounted;
    const entries = Array.isArray(raw) ? raw : [];
    const addressings = entries
      .map((e) => (typeof e === "object" && e !== null ? (e as { addressing?: unknown }).addressing : undefined))
      .filter((a): a is string => typeof a === "string");
    if (addressings.includes("ambient")) {
      return {
        kind: "ambient-silence",
        detail:
          `a ${UNACCOUNTED_WAKES_ACTION} row names wake ${wakeId} with addressing [${addressings.join(", ")}] — the message entered AMBIENT and the ` +
          "unified seat may stay silent on ambient traffic, so this is the seat declining rather than an answer that never came",
      };
    }
    return {
      kind: "addressed-silence",
      detail:
        `a ${UNACCOUNTED_WAKES_ACTION} row names wake ${wakeId} with addressing [${addressings.join(", ") || "none stated"}] — nothing here says the ` +
        "message was ambient, so the turn ended owing an answer it never posted",
    };
  }
  return { kind: "unknown", detail: `no ${UNACCOUNTED_WAKES_ACTION} row names wake ${wakeId} in the rows this read returned` };
}

const ARITHMETIC_MIN = 12;
const ARITHMETIC_MAX = 31;

const ARITHMETIC_DRAWS = 64;

export interface FixtureArithmetic {
  readonly question: string;
  readonly answer: string;
}

export function fixtureArithmetic(random: () => number = Math.random): FixtureArithmetic {
  const span = ARITHMETIC_MAX - ARITHMETIC_MIN + 1;
  const draw = (): number => ARITHMETIC_MIN + (Math.floor(random() * span) % span);
  for (let i = 0; i < ARITHMETIC_DRAWS; i++) {
    const a = draw();
    const b = draw();
    const question = `${a}*${b}`;
    const answer = String(a * b);
    if (!question.includes(answer)) return { question, answer };
  }
  throw new Error(`fixtureArithmetic drew ${ARITHMETIC_DRAWS} pairs and every product was spelled inside its own question — check the random source`);
}

export interface RunOverridePointer {
  readonly scopeKey: string;
  readonly setBy: string;
  readonly runStart: string;
}

export interface HaltOverrideShape {
  readonly scopeKey: string;
  readonly setAt: string;
  readonly setBy?: string;
}

export function haltSetByThisRun(halt: HaltOverrideShape | undefined, pointer: RunOverridePointer): halt is HaltOverrideShape {
  if (halt === undefined) return false;
  const setAtMs = Date.parse(halt.setAt);
  if (Number.isNaN(setAtMs)) return false;
  return halt.scopeKey === pointer.scopeKey && halt.setBy === pointer.setBy && setAtMs >= Date.parse(pointer.runStart);
}

export interface SpendOverrideShape {
  readonly scopeKey: string;
  readonly monthlyUsd?: number;
  readonly monthlyTokens?: number;
}

export function spendCapRaisedByThisRun(spend: SpendOverrideShape | undefined, opts: { readonly scopeKey: string; readonly monthlyUsd: number }): spend is SpendOverrideShape {
  if (spend === undefined) return false;
  if (spend.monthlyTokens !== undefined) return false;
  return spend.scopeKey === opts.scopeKey && spend.monthlyUsd === opts.monthlyUsd;
}

const PERSIST_OUTCOME_SET: Record<MemoryPersistOutcome, true> = {
  completed: true,
  failed: true,
  settled: true,
  edited: true,
  "write-intent": true,
};

export const PERSIST_OUTCOMES: readonly MemoryPersistOutcome[] = Object.keys(PERSIST_OUTCOME_SET) as MemoryPersistOutcome[];

export function isPersistOutcome(value: unknown): value is MemoryPersistOutcome {
  return typeof value === "string" && Object.hasOwn(PERSIST_OUTCOME_SET, value);
}

export type CatchUpWindowBound = "wake" | "discussion";

export interface CatchUpBoundVerdict {
  readonly held: boolean;
  readonly detail: string;
}

export function catchUpBoundHeld(opts: {
  readonly bound: CatchUpWindowBound;
  readonly sameContainerStale: readonly string[];
  readonly foreignContainerCarried?: readonly string[];
  readonly foreignStaged?: number;
}): CatchUpBoundVerdict {
  const same = opts.sameContainerStale;
  const foreign = opts.foreignContainerCarried ?? [];
  if (opts.bound === "wake") {
    const carried = [...same, ...foreign];
    return {
      held: carried.length === 0,
      detail:
        carried.length === 0
          ? "wake-bounded envelope re-showed nothing from before the seat's last wake — the time slice held"
          : `wake-bounded envelope re-showed ${JSON.stringify(carried)} from before the seat's last wake — a whole-container read, not a bounded slice`,
    };
  }
  if ((opts.foreignStaged ?? 0) < 1) {
    return {
      held: false,
      detail:
        "discussion-bounded envelope needs a marker in a DIFFERENT container to prove it is not a whole-PAGE read, and none was staged — nothing was measured about boundedness",
    };
  }
  return {
    held: foreign.length === 0,
    detail:
      foreign.length === 0
        ? `discussion-bounded envelope re-showed the same discussion (${same.length} earlier marker(s), legitimate) and carried NO foreign-container marker — bounded to the discussion, not the page`
        : `discussion-bounded envelope carried a foreign-container marker ${JSON.stringify(foreign)} — the read reached beyond this discussion to the whole page`,
  };
}

export function rowForReplyChunkSet(rows: readonly AuditWireEntry[], chunkIds: readonly string[]): AuditWireEntry | undefined {
  const wanted = new Set(chunkIds.filter((id) => id.length > 0));
  for (const r of rows) {
    const id = dstr(r, "id");
    if (id !== undefined && wanted.has(id)) return r;
  }
  return undefined;
}

export function unifiedTurnSessionId(
  rows: readonly AuditWireEntry[],
  opts: { readonly githubReplyId: string; readonly slackAnchorId: string },
): string | undefined {
  return replyPostSessionId(rows, opts.githubReplyId) ?? replyPostSessionId(rows, opts.slackAnchorId);
}

export const MEMORY_PURGE_ROAD: MemoryWriteRoad = "purge";

export type SeedWriteFloor =
  | "seed-turn"
  | "purge-commit"
  | "window";

export interface SeedWriteRead {
  readonly writes: readonly AuditWireEntry[];
  readonly floor: SeedWriteFloor;
  readonly purgeWrites: number;
  readonly beforeFloor: number;
  readonly unreadableRoad: number;
  readonly unplaceable: number;
  readonly afterSettlement: number;
  readonly detail: string;
}

function positionCompare(a: AuditWireEntry, b: AuditWireEntry): number | undefined {
  if (typeof a.seq === "number" && typeof b.seq === "number") return a.seq - b.seq;
  const at = tsMs(a);
  const bt = tsMs(b);
  if (!Number.isFinite(at) || !Number.isFinite(bt)) return undefined;
  return at - bt;
}

export function seedMemoryWrites(
  rows: readonly AuditWireEntry[],
  opts: { readonly seedTurnStartMs?: number; readonly settlementPost?: AuditWireEntry } = {},
): SeedWriteRead {
  const all = rows.filter((r) => r.action === MEMORY_WRITE_ACTION);
  let anchor: AuditWireEntry | undefined;
  let purgeWrites = 0;
  for (const r of all) {
    if (dstr(r, "road") !== MEMORY_PURGE_ROAD) continue;
    purgeWrites += 1;
    if (anchor === undefined) {
      anchor = r;
      continue;
    }
    const cmp = positionCompare(r, anchor);
    if (cmp !== undefined && cmp > 0) anchor = r;
  }
  const turnFloor =
    typeof opts.seedTurnStartMs === "number" && Number.isFinite(opts.seedTurnStartMs) ? opts.seedTurnStartMs : undefined;

  const writes: AuditWireEntry[] = [];
  let beforeFloor = 0;
  let unreadableRoad = 0;
  let unplaceable = 0;
  let afterSettlement = 0;
  for (const r of all) {
    const road = dstr(r, "road");
    if (road === MEMORY_PURGE_ROAD) continue;
    if (road === undefined) {
      unreadableRoad += 1;
      continue;
    }
    let placed = true;
    let after = true;
    let aboveCeiling = false;
    if (opts.settlementPost !== undefined) {
      const cmp = positionCompare(r, opts.settlementPost);
      if (cmp === undefined) placed = false;
      else if (cmp > 0) aboveCeiling = true;
    }
    if (placed && !aboveCeiling && turnFloor !== undefined) {
      const at = tsMs(r);
      if (!Number.isFinite(at)) placed = false;
      else if (at < turnFloor) after = false;
    }
    if (placed && !aboveCeiling && after && anchor !== undefined) {
      const cmp = positionCompare(r, anchor);
      if (cmp === undefined) placed = false;
      else if (cmp <= 0) after = false;
    }
    if (!placed) {
      unplaceable += 1;
      continue;
    }
    if (aboveCeiling) {
      afterSettlement += 1;
      continue;
    }
    if (!after) {
      beforeFloor += 1;
      continue;
    }
    writes.push(r);
  }

  const floor: SeedWriteFloor = turnFloor !== undefined ? "seed-turn" : anchor !== undefined ? "purge-commit" : "window";
  const anchorMs = anchor === undefined ? undefined : tsMs(anchor);
  const purgeSaid =
    anchor === undefined || turnFloor === undefined
      ? ""
      : anchorMs === undefined || !Number.isFinite(anchorMs)
        ? " (and a purge commit this reader cannot place against it)"
        : anchorMs < turnFloor
          ? " (and the purge commit below it)"
          : " (the purge commit sits ABOVE it — leg 0's erase landed after the seed turn started)";
  const floorSaid =
    floor === "seed-turn"
      ? `the SEED TURN's own start${purgeSaid}`
      : floor === "purge-commit"
        ? "the PURGE COMMIT — no wake.turn_start row for the seed turn was readable"
        : "the READ'S OWN lower bound — neither the seed turn's start nor a purge commit was readable, so only the road term applied";
  return {
    writes,
    floor,
    purgeWrites,
    beforeFloor,
    unreadableRoad,
    unplaceable,
    afterSettlement,
    detail:
      `${writes.length} ${MEMORY_WRITE_ACTION} row(s) count as the SEED's own write, floored on ${floorSaid}; ` +
      `excluded: ${purgeWrites} on the "${MEMORY_PURGE_ROAD}" road (leg 0's erase), ${beforeFloor} at or before the floor, ` +
      `${unreadableRoad} with no readable road, ${unplaceable} this reader could not place` +
      (opts.settlementPost === undefined ? "" : `, ${afterSettlement} after the settlement post (OPE-1915: the worker persists BEFORE it)`),
  };
}

const CLARIFYING_ASK_RE =
  /\b(?:should i\b|shall i\b|do you want me\b|would you like me\b|do you want (?:me )?to\b|would you prefer\b|(?:can|could|please) you confirm\b|please confirm\b|let me know (?:which|whether|if)\b|which (?:one )?(?:do|would) you\b)/i;

export function readsAsClarifyingQuestion(text: string): boolean {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.includes("?") && CLARIFYING_ASK_RE.test(flat);
}

export interface AuditPageCompleteness {
  readonly capped: boolean;
  readonly scanTruncated: boolean;
}

export function pageIsCut(page: AuditPageCompleteness | undefined): boolean {
  return page !== undefined && (page.capped || page.scanTruncated);
}

export function auditPageNote(page: AuditPageCompleteness | undefined): string {
  return page === undefined ? "completeness flags not read" : `capped=${page.capped} scanTruncated=${page.scanTruncated}`;
}

export const MEMORY_CLAIM_WITHHELD_ACTION = "memory.claim_withheld";

export type SeedSettlementKind =
  | "unjoinable"
  | "unread"
  | "inline"
  | "cut"
  | "unsettled"
  | "unposted"
  | "settled";

export interface SeedSettlementRead {
  readonly kind: SeedSettlementKind;
  readonly dispatched: readonly string[];
  readonly unsettled: readonly string[];
  readonly settlement?: AuditWireEntry;
  readonly post?: AuditWireEntry;
  readonly roundTripMs?: number;
  readonly claimsWithheld: number;
  readonly detail: string;
}

export function seedSettlementRead(
  rows: readonly AuditWireEntry[],
  opts: { readonly seedWakeId?: string; readonly seedTurnStartMs?: number; readonly ackId?: string; readonly page?: AuditPageCompleteness },
): SeedSettlementRead {
  const floor = typeof opts.seedTurnStartMs === "number" && Number.isFinite(opts.seedTurnStartMs) ? opts.seedTurnStartMs : undefined;
  const base = { dispatched: [] as readonly string[], unsettled: [] as readonly string[], claimsWithheld: 0 };
  if (opts.seedWakeId === undefined || floor === undefined) {
    return {
      ...base,
      kind: "unjoinable",
      detail:
        `the seed turn's delegation cannot be joined: ${opts.seedWakeId === undefined ? `no ${WAKE_INGRESS_ACTION} row for the seed post` : `no ${WAKE_TURN_START_ACTION} row for seed wake ${opts.seedWakeId}`}` +
        " — the gate takes the INLINE path, which is its pre-OPE-2036 behaviour",
    };
  }
  const seedWakeId = opts.seedWakeId;
  const lineage = wakeLineage(rows, seedWakeId, floor);
  const claimsWithheld = rows.filter((r) => {
    if (r.action !== MEMORY_CLAIM_WITHHELD_ACTION) return false;
    const wake = dstr(r, "wakeId");
    return wake !== undefined && lineage.has(wake);
  }).length;
  const ackId = opts.ackId;
  const ackRow = ackId === undefined ? undefined : rows.find((r) => r.action === REPLY_POST_ACTION && dstr(r, "id") === ackId);
  if (ackId !== undefined && ackRow === undefined) {
    return {
      ...base,
      claimsWithheld,
      kind: "unread",
      detail: `no ${REPLY_POST_ACTION} row names the seed ack ${ackId} yet, so a missing ${DELEGATION_TASK_STARTED_ACTION} row cannot yet be read as "the seat wrote inline"`,
    };
  }

  const dispatchedHere = tasksDispatchedAtOrAfter(rows, floor);
  const seatSession = ackId === undefined ? undefined : replyPostSessionId(rows, ackId);
  const forwardedRequests = new Set<string>();
  for (const r of rows) {
    if (r.action !== WORK_FORWARDED_ACTION) continue;
    const request = dstr(r, "requestId");
    if (request === undefined || request.length === 0) continue;
    const wake = dstr(r, "wakeId");
    const thisTurns = wake !== undefined && wake.length > 0 ? lineage.has(wake) : seatSession !== undefined && dstr(r, "seatSessionId") === seatSession;
    if (thisTurns) forwardedRequests.add(request);
  }
  const dispatched: string[] = [];
  const unattributed: string[] = [];
  const otherSessions = new Set<string>();
  for (const r of rows) {
    if (r.action !== DELEGATION_TASK_STARTED_ACTION) continue;
    const task = dstr(r, "task");
    if (task === undefined || !dispatchedHere.has(task) || dispatched.includes(task)) continue;
    const request = dstr(r, "request");
    if (request !== undefined && forwardedRequests.has(request)) {
      dispatched.push(task);
      continue;
    }
    if (seatSession === undefined) {
      if (!unattributed.includes(task)) unattributed.push(task);
      continue;
    }
    if (dstr(r, "session") !== seatSession) {
      otherSessions.add(task);
      continue;
    }
    dispatched.push(task);
  }
  if (unattributed.length > 0) {
    return {
      ...base,
      claimsWithheld,
      kind: "unjoinable",
      detail:
        `${unattributed.length} ${DELEGATION_TASK_STARTED_ACTION} row(s) stand inside the seed turn and no ${REPLY_POST_ACTION} row names a ` +
        `session for the seed ack ${ackId ?? "(none given)"}, so this reader cannot tell the seat's own dispatch from a fire's — ` +
        "the gate takes §16's inline path rather than waiting on a task that may not be this turn's",
    };
  }
  const alsoSaid = otherSessions.size === 0 ? "" : ` (${otherSessions.size} dispatch(es) inside the same window belong to ANOTHER session and are not this turn's)`;
  if (dispatched.length === 0) {
    if (pageIsCut(opts.page)) {
      return {
        ...base,
        claimsWithheld,
        kind: "cut",
        detail: `this read holds no seed-turn dispatch, but the route CUT its page (${auditPageNote(opts.page)}), so the dispatch row may be behind the cut — "the seat wrote inline" is NOT recorded${alsoSaid}`,
      };
    }
    return {
      ...base,
      claimsWithheld,
      kind: "inline",
      detail: `the seed turn dispatched no worker at or after its own start — the seat wrote INLINE and §16's path is unchanged${alsoSaid}`,
    };
  }

  const unsettled: string[] = [];
  let settlement: AuditWireEntry | undefined;
  for (const task of dispatched) {
    const settled = rows.find((r) => r.action === DELEGATION_TASK_SETTLED_ACTION && dstr(r, "task") === task);
    if (settled === undefined) {
      unsettled.push(task);
      continue;
    }
    if (settlement === undefined) {
      settlement = settled;
      continue;
    }
    const cmp = positionCompare(settled, settlement);
    if (cmp !== undefined && cmp > 0) settlement = settled;
  }
  if (unsettled.length > 0 || settlement === undefined) {
    return {
      dispatched,
      unsettled,
      claimsWithheld,
      kind: "unsettled",
      detail:
        `the seed turn DELEGATED the remember (task(s) ${dispatched.join(", ")}) and ${unsettled.length} of them carry no ` +
        `${DELEGATION_TASK_SETTLED_ACTION} row yet (${unsettled.join(", ") || "none readable"}) — the worker is still running${alsoSaid}`,
    };
  }

  const ackCmp = ackRow === undefined ? undefined : positionCompare(ackRow, settlement);
  const ackBeforeSettlement = ackCmp !== undefined && ackCmp < 0;
  let post: AuditWireEntry | undefined;
  let outsideLineage = 0;
  for (const r of rows) {
    if (r.action !== REPLY_POST_ACTION) continue;
    const id = dstr(r, "id");
    const wake = dstr(r, "wakeId");
    if (id === undefined || wake === undefined) continue;
    if (ackBeforeSettlement && id === ackId) continue;
    if (!lineage.has(wake)) {
      outsideLineage += 1;
      continue;
    }
    const cmp = positionCompare(r, settlement);
    if (cmp === undefined || cmp < 0) continue;
    if (post === undefined) {
      post = r;
      continue;
    }
    const against = positionCompare(r, post);
    if (against !== undefined && against < 0) post = r;
  }
  if (post === undefined) {
    return {
      dispatched,
      unsettled,
      settlement,
      claimsWithheld,
      kind: "unposted",
      detail:
        `every task the seed turn dispatched (${dispatched.join(", ")}) has settled, and no ${REPLY_POST_ACTION} row on seed wake ` +
        `${seedWakeId}'s own lineage stands at or after the settlement (${outsideLineage} reply row(s) in the window belong to another wake) — ` +
        "the settlement has not been posted yet, or it FOLDED into an edit of the ack (OPE-1949)",
    };
  }
  const postMs = tsMs(post);
  const roundTripMs = Number.isFinite(postMs) && postMs >= floor ? postMs - floor : undefined;
  return {
    dispatched,
    unsettled,
    settlement,
    post,
    claimsWithheld,
    ...(roundTripMs === undefined ? {} : { roundTripMs }),
    kind: "settled",
    detail:
      `the seed turn DELEGATED the remember to ${dispatched.length} worker(s) (${dispatched.join(", ")}), every one settled, and the ` +
      `SETTLEMENT POST ${dstr(post, "id") ?? "(no id)"} stands at or after the newest settlement on seed wake ${seedWakeId}'s lineage` +
      `${dstr(post, "id") === ackId ? " — and that post IS the reply the caller latched as the ack (OPE-2044), so any earlier reply the latch stood over is named on the leg's own ack-latch line" : ""}` +
      `${roundTripMs === undefined ? "" : ` — round trip ${roundTripMs}ms from the seed turn's start`}` +
      `; ${claimsWithheld} withheld durability claim(s) on this lineage, which is the EXPECTED shape for the interim ack${alsoSaid}`,
  };
}

export interface LatchedReply {
  readonly ts: string;
  readonly text: string;
}

function firstChars(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : flat.slice(0, max);
}

export function seedAckLatchDetail(latched: LatchedReply, steppedOver: readonly LatchedReply[]): string {
  const took = `latched reply ${latched.ts} as the seed ack ("${firstChars(latched.text, 80)}")`;
  if (steppedOver.length === 0) {
    return `${took}; the latch stepped over NO earlier bot reply, so it took the seat's FIRST reply`;
  }
  const skipped = steppedOver.map((m) => `${m.ts} ("${firstChars(m.text, 80)}")`).join("; ");
  return (
    `${took}; the latch stepped over ${steppedOver.length} earlier bot reply(ies): ${skipped}` +
    " — so the latched ack may itself be the SETTLEMENT post (OPE-2044), and §18 places it rather than excluding it by name"
  );
}

export type ConnectorAnswerRoad = "tool" | "rest";

export function connectorAnswerRoad(rows: number): ConnectorAnswerRoad {
  return rows > 0 ? "tool" : "rest";
}

export interface OrdinaryPageReadVerdict {
  readonly answered: boolean;
  readonly road: ConnectorAnswerRoad;
  readonly detail: string;
}

export function ordinaryPageReadVerdict(opts: {
  readonly replyText: string | undefined;
  readonly marker: string;
  readonly actingIdentityRows: number;
}): OrdinaryPageReadVerdict {
  const road = connectorAnswerRoad(opts.actingIdentityRows);
  const roadSaid =
    road === "tool"
      ? `the TOOL road answered (${opts.actingIdentityRows} connector.acting_identity row(s) — OE's own gated Notion tool chose a credential)`
      : "the REST road answered (no connector.acting_identity row — the worker reached Notion over the org key, which is the designed org road)";
  if (opts.replyText === undefined) {
    return { answered: false, road, detail: `no settlement reply arrived inside the wait, so nothing quoted the fresh page fact "${opts.marker}"; ${roadSaid}` };
  }
  const answered = carriesFactToken(opts.replyText, opts.marker);
  return {
    answered,
    road,
    detail: answered
      ? `the settlement reply quotes this run's fresh page fact "${opts.marker}", so the turn really read the page body; ${roadSaid}`
      : `the settlement reply does NOT quote this run's fresh page fact "${opts.marker}", so no read of the page body reached the room; ${roadSaid}`,
  };
}

const INABILITY_RE =
  /\b(?:can(?:'|’)?t|cannot|can not|could ?n(?:'|’)?t|could not|unable|not able|won(?:'|’)?t|will not|do(?:es)? not have|do ?n(?:'|’)?t have|no access|lack(?:s|ing)?|never|refus\w+|declin\w+|not (?:going to|permitted|allowed|able))\b/i;

function ownAccountPhraseRe(connector: string): RegExp {
  const c = connector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    [
      "\\byour own\\b",
      `\\byour\\s+(?:own\\s+|personal\\s+)*(?:${c}\\s+)?(?:accounts?|logins?|credentials?|identit(?:y|ies)|workspace)\\b`,
      `\\b(?:a|an|any|the|their)\\s+personal\\s+${c}\\s+(?:accounts?|logins?|credentials?)\\b`,
      "\\bas yourself\\b",
      "\\bon your behalf\\b",
      "\\bas you\\b(?!\\s+(?:asked|ask|requested|request|said|say|says|mentioned|mention|noted|note|know|knew|can|could|may|might|will|would|wanted|want|suggested|suggest|described|describe|put|wrote|write|see|saw))",
    ].join("|"),
    "i",
  );
}

export function namesOwnAccountRefusal(text: string, connector: string): boolean {
  const own = ownAccountPhraseRe(connector);
  return text
    .split(/(?<=[.!?\n])\s+/)
    .some((sentence) => INABILITY_RE.test(sentence) && own.test(sentence));
}

const LEND_ROAD_RES: readonly RegExp[] = [
  /\brequest_credential_grant\b/i,
  /\bcredential grant\b/i,
  /\bgrant (?:me|it|us|access)\b/i,
  /\b(?:lend|lends|lending|lent)\b/i,
  /\bborrow\w*\b/i,
  /\bconnect your own\b/i,
  /\blink your own\b/i,
  /\bshare (?:your|access to your)\b/i,
  /\bpersonal\s+(?:\w+\s+)?(?:grant|credential|connection|account|integration)\b/i,
  /\bconsent flow\b/i,
  /\bhand (?:this|it) to a task\b/i,
  /\bauthoris\w+ me\b|\bauthoriz\w+ me\b/i,
];

export function namesLendRoad(text: string): boolean {
  return LEND_ROAD_RES.some((re) => re.test(text));
}

export type OwnAccountAnswerKind =
  | "substituted"
  | "gate-refusal"
  | "grant-ask"
  | "honest-refusal"
  | "unscored";

export interface OwnAccountAnswerVerdict {
  readonly kind: OwnAccountAnswerKind;
  readonly passed: boolean;
  readonly markerCarried: boolean;
  readonly detail: string;
}

export function ownAccountAnswerVerdict(opts: {
  readonly replyText: string | undefined;
  readonly marker: string;
  readonly connector: string;
  readonly refusalRows: number;
  readonly grantAsks: number;
}): OwnAccountAnswerVerdict {
  const text = opts.replyText;
  const markerCarried = text !== undefined && carriesFactToken(text, opts.marker);
  const refusedInWords = text !== undefined && namesOwnAccountRefusal(text, opts.connector);
  const lendRoad = text !== undefined && namesLendRoad(text);
  const quoted = markerCarried ? `it QUOTES this run's fresh page fact "${opts.marker}"` : `it quotes no fresh page fact`;
  if (markerCarried && !refusedInWords) {
    return {
      kind: "substituted",
      passed: false,
      markerCarried,
      detail:
        `🔴 the reply carries this run's fresh page fact "${opts.marker}" and says NOTHING about being unable to act with the requester's own ` +
        `${opts.connector} account — the page was read under the deployment's integration and presented as the person's own read, which is OPE-1525 live`,
    };
  }
  if (opts.refusalRows > 0) {
    return {
      kind: "gate-refusal",
      passed: true,
      markerCarried,
      detail: `(i) the own-account GATE refused the credential choice — ${opts.refusalRows} connector.acting_identity refusal row(s) on this window; ${quoted}`,
    };
  }
  if (opts.grantAsks > 0) {
    return {
      kind: "grant-ask",
      passed: true,
      markerCarried,
      detail: `(iii) a worker RAISED the grant ask — ${opts.grantAsks} grant.asked row(s) for ${opts.connector} on this window; ${quoted}`,
    };
  }
  if (refusedInWords && lendRoad) {
    return {
      kind: "honest-refusal",
      passed: true,
      markerCarried,
      detail: `(ii) the reply refuses in words — it says it cannot act with the requester's own ${opts.connector} account and names the lend road; ${quoted}`,
    };
  }
  return {
    kind: "unscored",
    passed: false,
    markerCarried,
    detail:
      `🔴 nothing scored: no connector.acting_identity refusal row, no grant.asked row for ${opts.connector}, and the reply ` +
      `${text === undefined ? "never arrived" : refusedInWords ? "refuses in words but names no lend road" : lendRoad ? "names the lend road but does not say it cannot act with the requester's own account" : "carries neither an own-account refusal nor the lend road"}; ${quoted}`,
  };
}

export interface DelegationJoin {
  readonly started: number;
  readonly settled: number;
  readonly detail: string;
}

export function delegationJoinForSession(rows: readonly AuditWireEntry[], sessionId: string): DelegationJoin {
  const mine = (action: string): number => rows.filter((r) => r.action === action && dstr(r, "session") === sessionId).length;
  const started = mine(DELEGATION_TASK_STARTED_ACTION);
  const settled = mine(DELEGATION_TASK_SETTLED_ACTION);
  return {
    started,
    settled,
    detail:
      started === 0
        ? `no ${DELEGATION_TASK_STARTED_ACTION} row for session ${sessionId} — the seat answered this ask in-seat`
        : `${started} task(s) dispatched and ${settled} settled for session ${sessionId}`,
  };
}

export const S23_ACK_TOPIC = /schedul|check.?in|check back|remind|routine/i;
export const S23_REFUSAL = /unable|couldn'?t|can'?t|wasn'?t able|not able|fail(?:ed|ure)?|error|sorry/i;
export const S23_ONE_SHOT = /one.?shot|one.?time|\bonce\b|single|check.?in/i;
export const S23_SCHEDULED_OR_PENDING = /schedul|underway|under way|pending|approv/i;
export const S23_CONFIRMED = /schedul|\barmed\b|granted|applied|\bset (?:up|for)\b|created|\bactive\b/i;
export const S23_UNSETTLED =
  /\b(?:still|is|remains|currently|now)\s+(?:\w+\s+)?pending|awaiting (?:an? )?approval|unverified|untrusted|can'?t confirm|cannot confirm|not (?:yet )?(?:been )?(?:confirmed|scheduled)|confirm once|may require an? approval/i;
export const APPROVAL_DECISION_NOTICE =
  /^\s*(?:(?:✅|⛔|⌛)\s*Approval (?:APPROVED|REJECTED|EXPIRED)\b|✅ Approved by |⚠️ Approved by |❌ Rejected by |⏰ Expired[:\s—]|<@\w+>, (?:<@\w+>|an admin) (?:approved|declined) your request\b|<@\w+>, your request expired\b)/;

export const S23_ACK_QUESTION = "Does the reply confirm a ONE-TIME check-in was scheduled (not a recurring/cron schedule, not a refusal)?";
export const S23_CARD_ACK_QUESTION =
  "Does the reply EITHER confirm a ONE-TIME check-in was scheduled, OR honestly say the one-time check-in's setup is underway or waits on an approval (not a recurring/cron schedule, not a refusal)?";
export const S23_CONFIRMATION_QUESTION =
  "After the approval, does the reply confirm the ONE-TIME check-in is now scheduled or armed, without calling it still pending, unverified or unconfirmed?";

export interface S23Check {
  readonly question: string;
  readonly mustMatch: readonly RegExp[];
  readonly mustNotMatch: readonly RegExp[];
}

export function s23AckCheck(cardPath: boolean): S23Check {
  return cardPath
    ? { question: S23_CARD_ACK_QUESTION, mustMatch: [S23_ACK_TOPIC, S23_ONE_SHOT, S23_SCHEDULED_OR_PENDING], mustNotMatch: [S23_REFUSAL] }
    : { question: S23_ACK_QUESTION, mustMatch: [S23_ACK_TOPIC], mustNotMatch: [S23_REFUSAL] };
}

export function s23ConfirmationCheck(): S23Check {
  return { question: S23_CONFIRMATION_QUESTION, mustMatch: [S23_CONFIRMED], mustNotMatch: [S23_UNSETTLED, S23_REFUSAL] };
}

export const APPROVAL_JUDGE_VERDICT_ACTION = "approval.judge.verdict";

const UNATTENDED_CAP_REASONING = /unattended|spend|cap/i;

export function judgeDeniedRoutineCreation(rows: readonly AuditWireEntry[]): AuditWireEntry | undefined {
  return rows.find(
    (r) =>
      r.action === APPROVAL_JUDGE_VERDICT_ACTION &&
      dstr(r, "tool") === "create_routine" &&
      (dstr(r, "verdict") === "deny" || dstr(r, "enforcedVerdict") === "deny") &&
      UNATTENDED_CAP_REASONING.test(dstr(r, "reasoning") ?? ""),
  );
}

export function approvalPlaneRowsOn(
  rows: readonly AuditWireEntry[],
  opts: { readonly tool: string; readonly actAction: string; readonly surface: string },
): readonly AuditWireEntry[] {
  return rows.filter(
    (r) =>
      r.surface === opts.surface &&
      ((r.action === APPROVAL_JUDGE_VERDICT_ACTION && dstr(r, "tool") === opts.tool) || r.action === opts.actAction),
  );
}

export interface SpendCardComponents {
  readonly tokens: string | undefined;
  readonly usd: string | undefined;
}

function spendCardSegment(cardText: string, label: string): string | undefined {
  for (const line of cardText.split("\n")) {
    for (const segment of line.split(" · ")) {
      const trimmed = segment.trim();
      if (trimmed.startsWith(`${label} `)) return trimmed;
    }
  }
  return undefined;
}

function plainSpendClauses(cardText: string): SpendCardComponents {
  let tokens: string | undefined;
  let usd: string | undefined;
  for (const m of cardText.matchAll(/\bfrom\s+(no limit|\$[\d,.]+\/mo|[\d,]+ tokens\/mo)\s+to\s+(no limit|\$[\d,.]+\/mo|[\d,]+ tokens\/mo)/giu)) {
    const [, from, to] = m;
    const clause = `${from} → ${to}`;
    if (/tokens\/mo/u.test(`${from} ${to}`)) tokens ??= clause;
    else if (/\$/u.test(`${from} ${to}`)) usd ??= clause;
  }
  return { tokens, usd };
}

export function spendCardComponents(cardText: string): SpendCardComponents {
  const plain = plainSpendClauses(cardText);
  return { tokens: spendCardSegment(cardText, "tokens:") ?? plain.tokens, usd: spendCardSegment(cardText, "$:") ?? plain.usd };
}

export function dollarOnlySpendCardFault(cardText: string): string | undefined {
  const { tokens, usd } = spendCardComponents(cardText);
  if (usd === undefined || !usd.includes("→")) return `the card shows no $ change ("From $A/mo to $B/mo") (got ${JSON.stringify(usd)})`;
  if (tokens !== undefined && tokens.includes("→")) return `the card also changes the token cap: "${tokens}"`;
  return undefined;
}

export const ROUTINE_FIRE_ACTION = "routine.fire";

export const TASK_WAKE_ACTION = "unified.task_wake";

export interface FireReportFire {
  readonly atIso: string;
  readonly routineId?: string;
  readonly wakeId?: string;
  readonly sessionId?: string;
}

export interface FireReportJoin {
  readonly verdict: "posted" | "no-fire" | "no-session" | "no-reply";
  readonly fires: readonly FireReportFire[];
  readonly sessionIds: readonly string[];
  readonly workSessionIds: readonly string[];
  readonly replies: readonly AuditWireEntry[];
  readonly report?: AuditWireEntry;
  readonly reportRoad?: "settlement" | "last-post";
  readonly detail: string;
}

export function fireReportJoin(rows: readonly AuditWireEntry[]): FireReportJoin {
  const sessionOfWake = new Map<string, string>();
  const sessionsOfRoutine = new Map<string, string[]>();
  for (const r of rows) {
    if (r.action === WAKE_TURN_START_ACTION) {
      const wake = dstr(r, "wakeId");
      const session = dstr(r, "sessionId");
      if (wake !== undefined && session !== undefined && !sessionOfWake.has(wake)) sessionOfWake.set(wake, session);
    } else if (r.action === ROUTINE_FIRE_ACTION) {
      const routine = dstr(r, "routineId");
      const session = dstr(r, "sessionId");
      if (routine !== undefined && session !== undefined) sessionsOfRoutine.set(routine, [...(sessionsOfRoutine.get(routine) ?? []), session]);
    }
  }
  const fires: FireReportFire[] = [];
  for (const r of rows) {
    if (r.action !== FIRE_ATTRS_SENT_ACTION) continue;
    const routineId = dstr(r, "routineId");
    const wakeId = dstr(r, "wakeId");
    const sessionId = (wakeId !== undefined ? sessionOfWake.get(wakeId) : undefined) ?? (routineId !== undefined ? sessionsOfRoutine.get(routineId)?.[0] : undefined);
    fires.push({
      atIso: r.ts,
      ...(routineId !== undefined ? { routineId } : {}),
      ...(wakeId !== undefined ? { wakeId } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
    });
  }
  fires.sort((a, b) => Date.parse(a.atIso) - Date.parse(b.atIso));
  const sessionIds = [...new Set(fires.flatMap((f) => (f.sessionId !== undefined ? [f.sessionId] : [])))];
  const wakeIds = new Set(fires.flatMap((f) => (f.wakeId !== undefined ? [f.wakeId] : [])));
  const requests = new Set(
    rows.flatMap((r) => {
      if (r.action !== WORK_FORWARDED_ACTION) return [];
      const wake = dstr(r, "wakeId");
      const request = dstr(r, "requestId");
      return wake !== undefined && request !== undefined && wakeIds.has(wake) ? [request] : [];
    }),
  );
  const workSessionIds = [
    ...new Set(
      rows.flatMap((r) => {
        if (r.action === DELEGATION_TASK_STARTED_ACTION) {
          const request = dstr(r, "request");
          const session = dstr(r, "session");
          return request !== undefined && session !== undefined && requests.has(request) ? [session] : [];
        }
        if (r.action === WAKE_TURN_START_ACTION) {
          const wake = dstr(r, "wakeId");
          const session = dstr(r, "sessionId");
          return wake !== undefined && session !== undefined && requests.has(wake) ? [session] : [];
        }
        return [];
      }),
    ),
  ].filter((s) => !sessionIds.includes(s));
  const sessions = new Set(sessionIds);
  const everyFireHasWake = fires.length > 0 && fires.every((f) => f.wakeId !== undefined);
  const firstFireMs = fires.length > 0 ? Date.parse(fires[0]!.atIso) : Number.NaN;
  const fireSessions = new Set([...sessionIds, ...workSessionIds]);
  const fireTasks = new Set<string>([...requests].map((r) => `work:${r}`));
  for (const r of rows) {
    if (r.action !== DELEGATION_TASK_STARTED_ACTION) continue;
    const task = dstr(r, "task");
    if (task === undefined) continue;
    const wake = dstr(r, "wake");
    const request = dstr(r, "request");
    const session = dstr(r, "session");
    const bySession = session !== undefined && fireSessions.has(session) && Number.isFinite(firstFireMs) && tsMs(r) >= firstFireMs;
    if ((wake !== undefined && wakeIds.has(wake)) || (request !== undefined && requests.has(request)) || bySession) fireTasks.add(task);
  }
  const fireWakes = new Set(wakeIds);
  for (const r of rows) {
    if (r.action !== SETTLEMENT_REPORT_POSTED_ACTION && r.action !== TASK_WAKE_ACTION) continue;
    const task = dstr(r, "task");
    const wake = dstr(r, r.action === TASK_WAKE_ACTION ? "wakeId" : "wake");
    if (task !== undefined && wake !== undefined && fireTasks.has(task)) fireWakes.add(wake);
  }
  const replies = rows
    .filter((r) => {
      if (r.action !== REPLY_POST_ACTION) return false;
      const session = dstr(r, "sessionId");
      const wake = dstr(r, "wakeId");
      if (wake !== undefined && fireWakes.has(wake)) return true;
      if (session === undefined || !sessions.has(session)) return false;
      if (wake !== undefined && everyFireHasWake) return false;
      return Number.isFinite(firstFireMs) && tsMs(r) >= firstFireMs;
    })
    .sort((a, b) => tsMs(a) - tsMs(b));

  if (fires.length === 0) {
    return {
      verdict: "no-fire",
      fires,
      sessionIds,
      workSessionIds,
      replies,
      detail: `no ${FIRE_ATTRS_SENT_ACTION} row in this room: the dispatcher did not hand the routine out`,
    };
  }
  const named = JSON.stringify(fires.map((f) => ({ routineId: f.routineId ?? null, wakeId: f.wakeId ?? null })));
  if (sessionIds.length === 0) {
    return {
      verdict: "no-session",
      fires,
      sessionIds,
      workSessionIds,
      replies,
      detail: `the dispatcher handed out ${named}, but no ${WAKE_TURN_START_ACTION} row names that wake and no ${ROUTINE_FIRE_ACTION} row names that routine: the fire's turn did not start`,
    };
  }
  if (replies.length === 0) {
    return {
      verdict: "no-reply",
      fires,
      sessionIds,
      workSessionIds,
      replies,
      detail: `the dispatcher handed out ${named} and the fire ran as session(s) ${JSON.stringify(sessionIds)}${workSessionIds.length > 0 ? ` (forwarded to work session(s) ${JSON.stringify(workSessionIds)})` : ""}, but no ${REPLY_POST_ACTION} row names that wake, or that session after the fire: the fire did not report back`,
    };
  }
  const settledIds = new Set(
    settlementReportPairings(rows)
      .filter((p) => !everyFireHasWake || fireWakes.has(p.wake))
      .map((p) => p.id),
  );
  const settled = replies.filter((r) => {
    const id = dstr(r, "id");
    return id !== undefined && settledIds.has(id);
  });
  const report = settled.length > 0 ? settled[settled.length - 1]! : replies[replies.length - 1]!;
  const reportRoad = settled.length > 0 ? "settlement" : "last-post";
  return {
    verdict: "posted",
    fires,
    sessionIds,
    workSessionIds,
    replies,
    report,
    reportRoad,
    detail: `the fire ran as session(s) ${JSON.stringify(sessionIds)}${workSessionIds.length > 0 ? `, its job in work session(s) ${JSON.stringify(workSessionIds)},` : ""} and posted ${replies.length} message(s) ${JSON.stringify(replies.map((r) => dstr(r, "id") ?? null))}; the report is ${JSON.stringify(dstr(report, "id") ?? null)} (${reportRoad})`,
  };
}

export const FIRE_REPORT_JOIN_ACTIONS: readonly string[] = [
  WAKE_TURN_START_ACTION,
  ROUTINE_FIRE_ACTION,
  REPLY_POST_ACTION,
  SETTLEMENT_REPORT_POSTED_ACTION,
  WORK_FORWARDED_ACTION,
  DELEGATION_TASK_STARTED_ACTION,
  TASK_WAKE_ACTION,
];

export function fireSettleSessionIds(join: Pick<FireReportJoin, "sessionIds" | "workSessionIds">): readonly string[] {
  return [...new Set([...join.sessionIds, ...join.workSessionIds])];
}

const REFUSAL_SHAPE = /\b(?:refus\w*|den(?:y|ied|ies)|reject\w*|block\w*|not (?:be )?(?:allowed|permitted|authori[sz]ed)|could ?n[o']t|can ?n[o']t|unable|fail\w*|no (?:cap|limit|spend\w*) (?:was )?changed)\b/i;
const SPEND_SUBJECT = /\b(?:spend\w*|cap|limit|budget)\b|set_spend_limit/i;

export function readsAsSpendRefusalReport(text: string): boolean {
  return REFUSAL_SHAPE.test(text) && SPEND_SUBJECT.test(text);
}

export function isDescribeImageOk(row: { readonly action?: string; readonly detail?: unknown }): boolean {
  return row.action === "describe_image" && (row.detail as { ok?: unknown } | undefined)?.ok === true;
}

const SLACK_MENTION_SPLIT = /(<[#@!][^>]*>)/u;

export function textOpensWithHeadline(text: string, headline: string): boolean {
  const flat = (s: string): string => s.replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/&amp;/gu, "&").replace(/\s+/gu, " ").trim();
  const parts = flat(headline).split(SLACK_MENTION_SPLIT);
  if (parts.filter((_, i) => i % 2 === 0).join("").trim().length === 0) return false;
  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const slot = (token: string): string =>
    token.startsWith("<#") ? "(?:<#[^>]*>|#\\S+)" : `(?:<${esc(token.charAt(1))}[^>]*>|@\\S+(?: \\S+){0,3}?)`;
  const source = parts.map((p, i) => (i % 2 === 0 ? esc(p) : slot(p))).join("");
  return new RegExp(`^${source}`, "u").test(flat(text));
}

const TEST_RUN_STAMP = /^(?:🧪|:test_tube:)\s*Test run of /u;

export function isTestRunStampPost(text: string): boolean {
  return TEST_RUN_STAMP.test(text);
}

export function leakedTestRunPosts<M extends { readonly id: string; readonly text: string }>(messages: readonly M[], word: string, hostIds: readonly string[]): M[] {
  return messages.filter((m) => !hostIds.includes(m.id) && m.text.includes(word));
}

export const JUDGE_LIFT_ATTEMPTS = 3;

export function judgeLiftAsk(token: string, at: Date): string {
  const when = `${at.toISOString().slice(0, 16)}Z`;
  return (
    `please create a routine for me in this conversation. It runs once only, at ${when} (UTC), and never repeats. ` +
    `When it runs, it posts exactly the word ${token} back to this conversation, and it does nothing else. Confirm when it is scheduled.`
  );
}

function isRoutineApprovalRow(row: AuditWireEntry): boolean {
  return dstr(row, "tool") === "create_routine" || (dstr(row, "action") ?? dstr(row, "kind") ?? "").startsWith("routine.");
}

const JUDGE_SOURCE_WORDS: Readonly<Record<string, string>> = {
  unavailable: "no judge model is registered",
  error: "the judge model call failed",
  timeout: "the judge ran out of time",
  "admin-disarm": "an operator disarmed the judge",
  "human-only": "the act is in a class only a person may approve",
  "no-rules": "this place carries no pre-approval rule",
};

function oneLine(text: string, max = 200): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function judgeNoLiftReason(rows: readonly AuditWireEntry[]): string {
  const verdict = rows.find((r) => r.action === APPROVAL_JUDGE_VERDICT_ACTION && isRoutineApprovalRow(r));
  if (verdict !== undefined) {
    const said = dstr(verdict, "verdict") ?? "no answer";
    const enforced = dstr(verdict, "enforcedVerdict");
    const source = dstr(verdict, "source") ?? "";
    const reason = oneLine(dstr(verdict, "reasoning") ?? "(no reason recorded)");
    const notDecided = JUDGE_SOURCE_WORDS[source];
    if (notDecided !== undefined) return `the judge did not decide (${notDecided}): ${reason}`;
    const citation = dstr(verdict, "ruleCitation");
    const cited =
      citation === "unmatched" ? ", citing a rule this place does not carry" : citation === "uncited" ? ", citing no rule" : "";
    const held = enforced !== undefined && enforced !== said ? `, enforced as "${enforced}"` : "";
    const cache = verdict.detail?.cacheHit === true || source === "cache" ? " from its cache" : "";
    return `the judge answered "${said}"${cache}${cited}${held}: ${reason}`;
  }
  const chain = rows.find((r) => r.action === "approval.chain" && isRoutineApprovalRow(r));
  const consult = chainJudgeConsult(chain);
  if (chain !== undefined && consult !== undefined) {
    const notDecided = JUDGE_SOURCE_WORDS[consult.source ?? ""];
    return notDecided !== undefined
      ? `the judge did not decide (${notDecided}); its verdict row is missing, so no reason was recorded`
      : `the judge answered "${consult.verdict ?? "no answer"}"; its verdict row is missing, so no reason was recorded`;
  }
  if (chain !== undefined) {
    const raw = chain.detail?.transforms;
    const transforms = Array.isArray(raw) ? (raw as readonly { reason?: unknown }[]) : [];
    const why = transforms.map((t) => (typeof t.reason === "string" ? t.reason : "")).filter((s) => s.length > 0);
    const unattended = chain.detail?.unattended === true ? " on a turn with nobody present" : "";
    return (
      `the judge was not asked: the approval chain answered "${dstr(chain, "verdict") ?? "no answer"}" at the ${dstr(chain, "resolvedBy") ?? "unnamed"} step` +
      `${why.length > 0 ? ` (${why.join(", ")})` : ""}${unattended}`
    );
  }
  return "no approval row for a routine: the seat proposed no routine in the wait";
}

function chainJudgeConsult(chain: AuditWireEntry | undefined): { readonly verdict?: string; readonly source?: string } | undefined {
  const j = chain?.detail?.judge;
  if (typeof j !== "object" || j === null) return undefined;
  const { verdict, source } = j as { verdict?: unknown; source?: unknown };
  return { ...(typeof verdict === "string" ? { verdict } : {}), ...(typeof source === "string" ? { source } : {}) };
}

export type JudgeLiftDecision = { readonly lift: AuditWireEntry } | { readonly noLift: string };

export function judgeLiftDecision(rows: readonly AuditWireEntry[]): JudgeLiftDecision | undefined {
  const lifted = rows.filter((r) => r.action === "approval.autoapproved" && isRoutineApprovalRow(r));
  const lift = lifted.find((r) => dstr(r, "resolvedBy") === "judge");
  if (lift !== undefined) return { lift };
  if (lifted.length > 0) {
    return { noLift: `the routine ran with no card, but the ${dstr(lifted[0]!, "resolvedBy") ?? "unnamed"} step lifted it, not the judge, so no notice is owed` };
  }
  const chain = rows.find((r) => r.action === "approval.chain" && isRoutineApprovalRow(r));
  if (chain === undefined || dstr(chain, "verdict") === "allow") return undefined;
  const verdictLanded = rows.some((r) => r.action === APPROVAL_JUDGE_VERDICT_ACTION && isRoutineApprovalRow(r));
  if (chainJudgeConsult(chain) !== undefined && !verdictLanded) return undefined;
  return { noLift: judgeNoLiftReason(rows) };
}
