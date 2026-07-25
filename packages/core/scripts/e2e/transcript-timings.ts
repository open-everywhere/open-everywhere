import type { TranscriptWireEvent } from "./transcript-read.js";
import type { AuditWireEntry } from "./audit-read.js";

function ms(at: string | null | undefined): number | null {
  if (typeof at !== "string" || at.length === 0) return null;
  const n = Date.parse(at);
  return Number.isFinite(n) ? n : null;
}

function delta(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : b - a;
}

function field(e: TranscriptWireEvent, key: string): unknown {
  const d = e.data;
  return d && typeof d === "object" && !Array.isArray(d) ? (d as Record<string, unknown>)[key] : undefined;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function sumKnown(values: readonly (number | null)[]): number | null {
  const known = values.filter((v): v is number => v !== null);
  return known.length === 0 ? null : known.reduce((a, b) => a + b, 0);
}

export interface ToolCallTiming {
  readonly callId: string;
  readonly kind: string;
  readonly name: string | null;
  readonly stepIndex: number | null;
  readonly requestedAt: string | null;
  readonly resolvedAt: string | null;
  readonly wallMs: number | null;
  readonly status: string | null;
}

export interface StepTiming {
  readonly stepIndex: number | null;
  readonly turnId: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly wallMs: number | null;
  readonly ttftMs: number | null;
  readonly finishReason: string | null;
  readonly tokens: number | null;
  readonly costUsd: number | null;
  readonly generationId: string | null;
  readonly failed: boolean;
}

export type TurnOutcome = "completed" | "failed" | "cancelled" | "open";

export interface TurnTiming {
  readonly turnId: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly outcome: TurnOutcome;
  readonly wallMs: number | null;
  readonly preflightMs: number | null;
  readonly steps: readonly StepTiming[];
  readonly toolCalls: readonly ToolCallTiming[];
  readonly modelMs: number | null;
  readonly toolMs: number | null;
}

export interface SessionTiming {
  readonly sessionId: string | null;
  readonly firstAt: string | null;
  readonly lastAt: string | null;
  readonly wallMs: number | null;
  readonly bootMs: number | null;
  readonly turns: readonly TurnTiming[];
  readonly totals: {
    readonly turns: number;
    readonly steps: number;
    readonly toolCalls: number;
    readonly modelMs: number | null;
    readonly toolMs: number | null;
    readonly tokens: number | null;
    readonly costUsd: number | null;
  };
  readonly coverage: {
    readonly events: number;
    readonly withAt: number;
    readonly unpairedCalls: number;
  };
}

interface CallAccum {
  callId: string;
  kind: string;
  name: string | null;
  stepIndex: number | null;
  turnId: string | null;
  requestedAt: string | null;
  resolvedAt: string | null;
  status: string | null;
}

interface StepAccum {
  stepIndex: number | null;
  turnId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  firstDeltaAt: string | null;
  finishReason: string | null;
  tokens: number | null;
  costUsd: number | null;
  generationId: string | null;
  failed: boolean;
}

interface TurnAccum {
  turnId: string;
  startedAt: string | null;
  endedAt: string | null;
  outcome: TurnOutcome;
  steps: Map<string, StepAccum>;
  calls: Map<string, CallAccum>;
}

function requestedActions(e: TranscriptWireEvent): { callId: string; kind: string; name: string | null }[] {
  const raw = field(e, "actions");
  if (!Array.isArray(raw)) return [];
  const out: { callId: string; kind: string; name: string | null }[] = [];
  for (const a of raw) {
    if (!a || typeof a !== "object") continue;
    const rec = a as Record<string, unknown>;
    const callId = str(rec["callId"]);
    if (!callId) continue;
    out.push({
      callId,
      kind: str(rec["kind"]) ?? "unknown",
      name: str(rec["toolName"]) ?? str(rec["subagentName"]) ?? str(rec["remoteAgentName"]) ?? str(rec["name"]),
    });
  }
  return out;
}

function stepKey(turnId: string | null, stepIndex: number | null): string {
  return `${turnId ?? "-"}#${stepIndex ?? "-"}`;
}

export function decomposeSession(events: readonly TranscriptWireEvent[]): SessionTiming {
  const turns = new Map<string, TurnAccum>();
  const order: string[] = [];
  let sessionId: string | null = null;
  let sessionStartedAt: string | null = null;
  let firstTurnStartedAt: string | null = null;
  let firstAt: string | null = null;
  let lastAt: string | null = null;
  let withAt = 0;

  const turnOf = (turnId: string | null): TurnAccum | null => {
    if (!turnId) return null;
    let t = turns.get(turnId);
    if (!t) {
      t = { turnId, startedAt: null, endedAt: null, outcome: "open", steps: new Map(), calls: new Map() };
      turns.set(turnId, t);
      order.push(turnId);
    }
    return t;
  };

  const stepOf = (t: TurnAccum, stepIndex: number | null): StepAccum => {
    const k = stepKey(t.turnId, stepIndex);
    let s = t.steps.get(k);
    if (!s) {
      s = {
        stepIndex, turnId: t.turnId, startedAt: null, endedAt: null, firstDeltaAt: null,
        finishReason: null, tokens: null, costUsd: null, generationId: null, failed: false,
      };
      t.steps.set(k, s);
    }
    return s;
  };

  for (const e of events) {
    if (ms(e.at) !== null) {
      withAt++;
      if (firstAt === null) firstAt = e.at;
      lastAt = e.at;
    }
    const turnId = str(field(e, "turnId"));
    const stepIndex = num(field(e, "stepIndex"));

    switch (e.type) {
      case "session.started":
        sessionStartedAt = e.at;
        break;
      case "session.failed":
        sessionId = sessionId ?? str(field(e, "sessionId"));
        break;
      case "compaction.requested":
      case "compaction.completed":
        sessionId = sessionId ?? str(field(e, "sessionId"));
        break;
      case "turn.started": {
        const t = turnOf(turnId);
        if (t) t.startedAt = t.startedAt ?? e.at;
        if (firstTurnStartedAt === null) firstTurnStartedAt = e.at;
        break;
      }
      case "turn.completed":
      case "turn.failed":
      case "turn.cancelled": {
        const t = turnOf(turnId);
        if (t) {
          t.endedAt = e.at;
          t.outcome = e.type === "turn.completed" ? "completed" : e.type === "turn.failed" ? "failed" : "cancelled";
        }
        break;
      }
      case "step.started": {
        const t = turnOf(turnId);
        if (t) stepOf(t, stepIndex).startedAt = e.at;
        break;
      }
      case "reasoning.appended":
      case "message.appended": {
        const t = turnOf(turnId);
        if (t) {
          const s = stepOf(t, stepIndex);
          if (s.firstDeltaAt === null) s.firstDeltaAt = e.at;
        }
        break;
      }
      case "step.completed": {
        const t = turnOf(turnId);
        if (!t) break;
        const s = stepOf(t, stepIndex);
        s.endedAt = e.at;
        s.finishReason = str(field(e, "finishReason"));
        const usage = field(e, "usage");
        if (usage && typeof usage === "object") {
          const u = usage as Record<string, unknown>;
          const tok = sumKnown([num(u["inputTokens"]), num(u["outputTokens"]), num(u["cacheReadTokens"]), num(u["cacheWriteTokens"])]);
          s.tokens = tok;
          s.costUsd = num(u["costUsd"]);
        }
        const pm = field(e, "providerMetadata");
        if (pm && typeof pm === "object") {
          const gw = (pm as Record<string, unknown>)["gateway"];
          if (gw && typeof gw === "object") s.generationId = str((gw as Record<string, unknown>)["generationId"]);
        }
        break;
      }
      case "step.failed": {
        const t = turnOf(turnId);
        if (!t) break;
        const s = stepOf(t, stepIndex);
        s.endedAt = e.at;
        s.failed = true;
        break;
      }
      case "actions.requested": {
        const t = turnOf(turnId);
        if (!t) break;
        for (const a of requestedActions(e)) {
          if (t.calls.has(a.callId)) continue;
          t.calls.set(a.callId, {
            callId: a.callId, kind: a.kind, name: a.name, stepIndex, turnId: t.turnId,
            requestedAt: e.at, resolvedAt: null, status: null,
          });
        }
        break;
      }
      case "action.result": {
        const t = turnOf(turnId);
        if (!t) break;
        const result = field(e, "result");
        const callId = result && typeof result === "object" ? str((result as Record<string, unknown>)["callId"]) : null;
        if (!callId) break;
        const c = t.calls.get(callId);
        if (c) {
          c.resolvedAt = e.at;
          c.status = str(field(e, "status"));
        } else {
          t.calls.set(callId, {
            callId, kind: "unknown", name: null, stepIndex, turnId: t.turnId,
            requestedAt: null, resolvedAt: e.at, status: str(field(e, "status")),
          });
        }
        break;
      }
      default:
        break;
    }
  }

  const turnTimings: TurnTiming[] = order.map((id) => {
    const t = turns.get(id)!;
    const steps: StepTiming[] = [...t.steps.values()].map((s) => ({
      stepIndex: s.stepIndex,
      turnId: s.turnId,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      wallMs: delta(ms(s.startedAt), ms(s.endedAt)),
      ttftMs: delta(ms(s.startedAt), ms(s.firstDeltaAt)),
      finishReason: s.finishReason,
      tokens: s.tokens,
      costUsd: s.costUsd,
      generationId: s.generationId,
      failed: s.failed,
    }));
    const toolCalls: ToolCallTiming[] = [...t.calls.values()].map((c) => ({
      callId: c.callId,
      kind: c.kind,
      name: c.name,
      stepIndex: c.stepIndex,
      requestedAt: c.requestedAt,
      resolvedAt: c.resolvedAt,
      wallMs: delta(ms(c.requestedAt), ms(c.resolvedAt)),
      status: c.status,
    }));
    const firstStepStart = steps.map((s) => ms(s.startedAt)).filter((v): v is number => v !== null).sort((a, b) => a - b)[0] ?? null;
    return {
      turnId: t.turnId,
      startedAt: t.startedAt,
      endedAt: t.endedAt,
      outcome: t.outcome,
      wallMs: delta(ms(t.startedAt), ms(t.endedAt)),
      preflightMs: delta(ms(t.startedAt), firstStepStart),
      steps,
      toolCalls,
      modelMs: sumKnown(steps.map((s) => s.wallMs)),
      toolMs: sumKnown(toolCalls.map((c) => c.wallMs)),
    };
  });

  const allSteps = turnTimings.flatMap((t) => t.steps);
  const allCalls = turnTimings.flatMap((t) => t.toolCalls);
  return {
    sessionId,
    firstAt,
    lastAt,
    wallMs: delta(ms(firstAt), ms(lastAt)),
    bootMs: delta(ms(sessionStartedAt), ms(firstTurnStartedAt)),
    turns: turnTimings,
    totals: {
      turns: turnTimings.length,
      steps: allSteps.length,
      toolCalls: allCalls.length,
      modelMs: sumKnown(turnTimings.map((t) => t.modelMs)),
      toolMs: sumKnown(turnTimings.map((t) => t.toolMs)),
      tokens: sumKnown(allSteps.map((s) => s.tokens)),
      costUsd: sumKnown(allSteps.map((s) => s.costUsd)),
    },
    coverage: {
      events: events.length,
      withAt,
      unpairedCalls: allCalls.filter((c) => c.requestedAt === null || c.resolvedAt === null).length,
    },
  };
}

export const TASK_SPAWNED_ACTION = "task.spawned";
export const TASK_RETURNED_ACTION = "task.returned";

export interface DelegationTiming {
  readonly taskId: string;
  readonly parentSessionId: string | null;
  readonly workerSessionId: string | null;
  readonly mode: string | null;
  readonly spawnedAt: string;
  readonly returnedAt: string | null;
  readonly hasError: boolean;
  readonly delivered: boolean | null;
  readonly wallMs: number | null;
  readonly dispatchMs: number | null;
  readonly bootMs: number | null;
  readonly ttftMs: number | null;
  readonly workMs: number | null;
  readonly returnMs: number | null;
  readonly unaccountedMs: number | null;
  readonly worker: SessionTiming | null;
  readonly gaps: readonly string[];
}

function detailStr(row: AuditWireEntry, key: string): string | null {
  const v = row.detail?.[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function detailBool(row: AuditWireEntry, key: string): boolean | null {
  const v = row.detail?.[key];
  return typeof v === "boolean" ? v : null;
}

export function delegationJoinTargets(rows: readonly AuditWireEntry[]): {
  readonly taskId: string;
  readonly parentSessionId: string | null;
  readonly workerSessionId: string | null;
}[] {
  const spawns = rows.filter((r) => r.action === TASK_SPAWNED_ACTION);
  return spawns.map((s) => {
    const taskId = detailStr(s, "taskId") ?? "";
    const ret = rows.find((r) => r.action === TASK_RETURNED_ACTION && detailStr(r, "taskId") === taskId);
    return {
      taskId,
      parentSessionId: detailStr(s, "parentSessionId"),
      workerSessionId: ret ? detailStr(ret, "sessionId") : null,
    };
  }).filter((t) => t.taskId.length > 0);
}

export function joinDelegations(
  rows: readonly AuditWireEntry[],
  workerTranscripts: ReadonlyMap<string, readonly TranscriptWireEvent[]>,
): DelegationTiming[] {
  const spawns = rows.filter((r) => r.action === TASK_SPAWNED_ACTION && detailStr(r, "taskId") !== null);
  const out: DelegationTiming[] = [];

  for (const spawn of spawns) {
    const taskId = detailStr(spawn, "taskId")!;
    const ret = rows.find((r) => r.action === TASK_RETURNED_ACTION && detailStr(r, "taskId") === taskId) ?? null;
    const gaps: string[] = [];

    if (!ret) gaps.push("no task.returned row for this taskId (the worker never reported back inside the read window)");
    const workerSessionId = ret ? detailStr(ret, "sessionId") : null;
    if (ret && !workerSessionId) {
      gaps.push("task.returned carries no sessionId (pre-OPE-121 row, or the worker had no session context) — the worker's own work is unobservable");
    }
    const events = workerSessionId ? workerTranscripts.get(workerSessionId) ?? null : null;
    if (workerSessionId && !events) gaps.push(`no transcript supplied for worker session ${workerSessionId}`);
    if (events && events.length === 0) gaps.push(`worker session ${workerSessionId} replayed EMPTY (expired/unreadable) — phases unmeasurable`);

    const worker = events && events.length > 0 ? decomposeSession(events) : null;
    if (worker && worker.coverage.withAt < worker.coverage.events) {
      gaps.push(`worker transcript has ${worker.coverage.events - worker.coverage.withAt} event(s) with no timestamp — eve stopped stamping meta.at`);
    }

    const spawnedMs = ms(spawn.ts);
    const returnedMs = ret ? ms(ret.ts) : null;
    const firstWorkerMs = worker ? ms(worker.firstAt) : null;
    const lastWorkerMs = worker ? ms(worker.lastAt) : null;
    const firstTurn = worker?.turns[0] ?? null;
    const lastTurnEnd = worker
      ? worker.turns.map((t) => ms(t.endedAt)).filter((v): v is number => v !== null).sort((a, b) => b - a)[0] ?? null
      : null;
    const firstStep = firstTurn?.steps[0] ?? null;

    const wallMs = delta(spawnedMs, returnedMs);
    const dispatchMs = delta(spawnedMs, firstWorkerMs);
    const bootMs = worker?.bootMs ?? null;
    const ttftMs = firstStep?.ttftMs ?? null;
    const workMs = delta(ms(firstTurn?.startedAt ?? null), lastTurnEnd);
    const returnMs = delta(lastWorkerMs, returnedMs);
    const accounted = sumKnown([dispatchMs, bootMs, workMs, returnMs]);
    const unaccountedMs = wallMs !== null && accounted !== null ? wallMs - accounted : null;

    out.push({
      taskId,
      parentSessionId: detailStr(spawn, "parentSessionId"),
      workerSessionId,
      mode: ret ? detailStr(ret, "mode") : null,
      spawnedAt: spawn.ts,
      returnedAt: ret?.ts ?? null,
      hasError: ret ? detailBool(ret, "hasError") === true : false,
      delivered: ret ? detailBool(ret, "delivered") : null,
      wallMs,
      dispatchMs,
      bootMs,
      ttftMs,
      workMs,
      returnMs,
      unaccountedMs,
      worker,
      gaps,
    });
  }

  return out.sort((a, b) => (ms(a.spawnedAt) ?? 0) - (ms(b.spawnedAt) ?? 0));
}

export const MEMORY_SYNC_TIMING_ACTION = "memory.sync_timing";

export interface SiloSyncTiming {
  readonly silo: string | null;
  readonly tier: string | null;
  readonly provider: string | null;
  readonly readOnly: boolean | null;
  readonly loadMs: number | null;
  readonly syncMs: number | null;
  readonly lockMs: number | null;
  readonly files: number | null;
  readonly bytes: number | null;
  readonly ok: boolean | null;
  readonly totalMs: number | null;
}

export interface MemorySyncTiming {
  readonly sessionId: string | null;
  readonly hookMs: number | null;
  readonly baselineMs: number | null;
  readonly sandboxMs: number | null;
  readonly indexMs: number | null;
  readonly versionsMs: number | null;
  readonly silos: readonly SiloSyncTiming[];
}

export interface BootAttribution {
  readonly bootMs: number | null;
  readonly hookMs: number | null;
  readonly sandboxMs: number | null;
  readonly baselineMs: number | null;
  readonly siloMs: number | null;
  readonly indexMs: number | null;
  readonly versionsMs: number | null;
  readonly unattributedMs: number | null;
  readonly silos: readonly SiloSyncTiming[];
  readonly gaps: readonly string[];
}

function detailNum(d: Record<string, unknown> | undefined, key: string): number | null {
  return num(d?.[key]);
}

export function projectMemorySync(
  rows: readonly AuditWireEntry[],
  sessionId: string | null,
): MemorySyncTiming | null {
  const candidates = rows.filter((r) => r.action === MEMORY_SYNC_TIMING_ACTION);
  const row = sessionId === null
    ? candidates[0] ?? null
    : candidates.find((r) => detailStr(r, "sessionId") === sessionId) ?? null;
  if (!row) return null;
  const d = row.detail;
  const rawSilos = Array.isArray(d?.["silos"]) ? (d?.["silos"] as unknown[]) : [];
  const silos: SiloSyncTiming[] = [];
  for (const raw of rawSilos) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const s = raw as Record<string, unknown>;
    const loadMs = num(s["loadMs"]);
    const syncMs = num(s["syncMs"]);
    const lockMs = num(s["lockMs"]);
    silos.push({
      silo: str(s["silo"]),
      tier: str(s["tier"]),
      provider: str(s["provider"]),
      readOnly: typeof s["readOnly"] === "boolean" ? (s["readOnly"] as boolean) : null,
      loadMs,
      syncMs,
      lockMs,
      files: num(s["files"]),
      bytes: num(s["bytes"]),
      ok: typeof s["ok"] === "boolean" ? (s["ok"] as boolean) : null,
      totalMs: sumKnown([loadMs, syncMs !== null && syncMs >= 0 ? syncMs : null, lockMs]),
    });
  }
  return {
    sessionId: detailStr(row, "sessionId"),
    hookMs: detailNum(d, "hookMs"),
    baselineMs: detailNum(d, "baselineMs"),
    sandboxMs: detailNum(d, "sandboxMs"),
    indexMs: detailNum(d, "indexMs"),
    versionsMs: detailNum(d, "versionsMs"),
    silos,
  };
}

export function attributeBoot(
  session: SessionTiming,
  rows: readonly AuditWireEntry[],
  sessionId: string | null = session.sessionId,
): BootAttribution | null {
  const sync = projectMemorySync(rows, sessionId);
  if (!sync) return null;
  const gaps: string[] = [];
  if (session.bootMs === null) gaps.push("no bootMs in this replay (paged read with no session.started) — the split has nothing to subtract from");
  if (sync.silos.length === 0) gaps.push("the sync row lists ZERO silos — this session's memory plan was empty, so its boot contains no memory work and no sandbox create");
  for (const s of sync.silos) if (s.ok === false) gaps.push(`silo ${s.silo ?? "?"} FAILED to materialise but still spent boot time`);
  const siloMs = sumKnown(sync.silos.map((s) => s.totalMs));
  return {
    bootMs: session.bootMs,
    hookMs: sync.hookMs,
    sandboxMs: sync.sandboxMs,
    baselineMs: sync.baselineMs,
    siloMs,
    indexMs: sync.indexMs,
    versionsMs: sync.versionsMs,
    unattributedMs: delta(sync.hookMs, session.bootMs),
    silos: [...sync.silos].sort((a, b) => (b.totalMs ?? -1) - (a.totalMs ?? -1)),
    gaps,
  };
}

export function fmtMs(v: number | null): string {
  if (v === null) return "?";
  return v >= 10_000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`;
}

export function renderDelegationTiming(d: DelegationTiming): string[] {
  const lines = [
    `delegation ${d.taskId.slice(-24)} — wall ≥${fmtMs(d.wallMs)}` +
      `${d.mode ? ` (${d.mode})` : ""}${d.hasError ? " ERROR" : ""}`,
    `  dispatch ${fmtMs(d.dispatchMs)}${d.dispatchMs !== null && d.dispatchMs < 0 ? " (worker beat the spawn row — benign race)" : ""}` +
      ` → boot(sandbox+memory) ${fmtMs(d.bootMs)} → ttft ${fmtMs(d.ttftMs)}` +
      ` → work ${fmtMs(d.workMs)} → return ${fmtMs(d.returnMs)} | unaccounted ${fmtMs(d.unaccountedMs)}`,
  ];
  if (d.worker) {
    const t = d.worker.totals;
    lines.push(`  worker ${d.workerSessionId}: ${t.turns} turn(s), ${t.steps} step(s), ${t.toolCalls} tool call(s), model ${fmtMs(t.modelMs)}, tools ${fmtMs(t.toolMs)}`);
    const slowest = [...d.worker.turns.flatMap((x) => x.toolCalls)]
      .filter((c) => c.wallMs !== null)
      .sort((a, b) => (b.wallMs ?? 0) - (a.wallMs ?? 0))
      .slice(0, 3);
    if (slowest.length > 0) lines.push(`  slowest calls: ${slowest.map((c) => `${c.name ?? c.kind} ${fmtMs(c.wallMs)}`).join(", ")}`);
  }
  for (const g of d.gaps) lines.push(`  ⚠ gap: ${g}`);
  return lines;
}

export function renderBootAttribution(a: BootAttribution): string[] {
  const lines = [
    `boot ${fmtMs(a.bootMs)} = memory hook ${fmtMs(a.hookMs)} + other session.started work ${fmtMs(a.unattributedMs)}`,
    `  memory hook: sandbox-create ${fmtMs(a.sandboxMs)}, write-baseline ${fmtMs(a.baselineMs)},` +
      ` silos ${fmtMs(a.siloMs)}, index ${fmtMs(a.indexMs)}, version-probes ${fmtMs(a.versionsMs)}`,
  ];
  for (const s of a.silos) {
    lines.push(
      `  silo ${s.silo ?? "?"} (${s.provider ?? "?"}${s.readOnly ? ", ro" : ""}): total ${fmtMs(s.totalMs)}` +
        ` = load ${fmtMs(s.loadMs)} + sync ${fmtMs(s.syncMs !== null && s.syncMs >= 0 ? s.syncMs : null)}` +
        `${s.lockMs !== null ? ` + lock ${fmtMs(s.lockMs)}` : ""}` +
        ` | ${s.files ?? "?"} file(s), ${s.bytes ?? "?"} byte(s)${s.ok === false ? " — FAILED" : ""}`,
    );
  }
  for (const g of a.gaps) lines.push(`  ⚠ gap: ${g}`);
  return lines;
}

export function renderSessionTiming(s: SessionTiming, label: string): string[] {
  const lines = [
    `${label}: ${s.totals.turns} turn(s), ${s.totals.steps} step(s), ${s.totals.toolCalls} tool call(s)` +
      ` — boot ${fmtMs(s.bootMs)}, model ${fmtMs(s.totals.modelMs)}, tools ${fmtMs(s.totals.toolMs)}` +
      `${s.totals.tokens !== null ? `, ${s.totals.tokens} tok` : ""}`,
  ];
  for (const t of s.turns) {
    const ttft = t.steps[0]?.ttftMs ?? null;
    lines.push(`  turn ${t.turnId.slice(-12)} ${t.outcome}: wall ${fmtMs(t.wallMs)}, preflight ${fmtMs(t.preflightMs)}, ttft ${fmtMs(ttft)}, ${t.steps.length} step(s)`);
  }
  if (s.coverage.withAt < s.coverage.events) {
    lines.push(`  ⚠ ${s.coverage.events - s.coverage.withAt}/${s.coverage.events} event(s) carry no timestamp`);
  }
  return lines;
}
