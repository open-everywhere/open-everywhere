import type { AuditWireEntry } from "./audit-read.js";
import { WAKE_INGRESS_ACTION, WAKE_TURN_START_ACTION } from "../../agent/channels/wake-timing.js";
import type { MemoryPersistOutcome } from "../../agent/hooks/memory.js";
import { DELEGATION_TASK_STARTED_ACTION, tasksDispatchedAtOrAfter, wakeLineage } from "./read-channel-lib.js";

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
  return salt.length === 0 ? text : `${text} (run ${salt})`;
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
  return !MEMORY_OWN_PERSIST_ROADS.includes(road);
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

export function memoryPathReadsBetween(
  events: readonly ReplayedEvent[],
  opts: { readonly fromText: string; readonly toText: string; readonly extractPaths: (events: readonly ReplayedEvent[]) => readonly string[] },
): MemoryReadSlice {
  const bodyOf = (e: ReplayedEvent): string => JSON.stringify({ type: e.type, data: e.data });
  let fromIndex: number | undefined;
  let toIndex: number | undefined;
  for (const e of events) {
    const body = bodyOf(e);
    if (fromIndex === undefined) {
      if (opts.fromText.length > 0 && body.includes(opts.fromText)) fromIndex = e.index;
      continue;
    }
    if (e.index > fromIndex && opts.toText.length > 0 && body.includes(opts.toText)) {
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

function replyPostWakeId(rows: readonly AuditWireEntry[], messageId: string): string | undefined {
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
  if (!tasksDispatchedAtOrAfter(rows, opts.floorMs).has(pairing.task)) {
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

export function unattendedArmRoad(args: {
  readonly planeRows: number;
  readonly workerRows: readonly AuditWireEntry[];
  readonly op: string;
}): UnattendedArmRoad {
  const road = workerRoadForOp(args.workerRows, args.op);
  const note =
    road.workers === 0
      ? `no ${WORKER_TOOLSET_ACTION} row in this window, so no delegated worker ran and the fire's own seat is where the call had to come from`
      : road.mounted
        ? `${road.workers} delegated worker(s) ran and at least one MOUNTED ${args.op}, so the connector road was open to the work`
        : road.explained === 0
          ? `${road.workers} delegated worker(s) ran, none mounted ${args.op}, and NO roster could be read whole (a non-array tools list, or one the emitter truncated) — an unreadable roster cannot say which road the seat took`
          : `NO CONNECTOR CALL HAPPENED: ${road.workers} delegated worker(s) ran and none mounted ${args.op} (one roster: ${JSON.stringify(road.sample)}) — the seat took another road, so the fence was never on it`;
  const verdict: UnattendedArmVerdict = args.planeRows > 0 ? "measured" : !road.mounted && road.explained > 0 ? "not-proven" : "unexplained";
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
