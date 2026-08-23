import { processRegistryMap } from "@open-everywhere/core/agent/lib/process-registry.js";

export const SCRIPTED_MODEL_ENV = "OE_SCRIPTED_MODEL";

export const SCRIPTED_MODEL_ID = "open-everywhere/scripted-model";

export function scriptedModelArmed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SCRIPTED_MODEL_ENV] === "1";
}

export interface ScriptedCall {
  readonly tool: string;
  readonly input?: unknown;
  readonly id?: string;
}

export interface ScriptedUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface ScriptedStep {
  readonly say?: string;
  readonly calls?: readonly ScriptedCall[];
  readonly usage?: ScriptedUsage;
  readonly delayMs?: number;
}

export interface SeatScript {
  readonly parent: readonly ScriptedStep[];
  readonly child?: readonly ScriptedStep[];
}

export type ScriptedRole = "parent" | "child";

export interface RecordedToolResult {
  readonly name: string;
  readonly isError: boolean;
  readonly output: unknown;
}

export interface ToolDefinitionRecord {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}

export interface RecordedRequest {
  readonly role: ScriptedRole;
  readonly sessionId: string | undefined;
  readonly turnId: string | undefined;
  readonly stepIndex: number;
  readonly pid: number;
  readonly tools: readonly string[];
  readonly toolDefinitions: readonly ToolDefinitionRecord[];
  readonly toolResults: readonly RecordedToolResult[];
  readonly messages: readonly { readonly role: string; readonly text: string }[];
  readonly fault?: string;
}

export interface ResolveObservation {
  readonly role: ScriptedRole;
  readonly sessionId: string | undefined;
  readonly turnId: string | undefined;
  readonly stepIndex: number;
  readonly pid: number;
  readonly channelKind: string | undefined;
  readonly classifiedKind: string;
  readonly hasSessionParent: boolean;
  fault?: string;
  readonly eventEcho?: unknown;
}

export interface ScriptedEntry {
  readonly script: SeatScript;
  readonly requests: RecordedRequest[];
  readonly resolves: ResolveObservation[];
  readonly baselines: Record<string, number>;
  readonly firstCallTurnByRole: Partial<Record<ScriptedRole, string>>;
  readonly registeredAt: string;
  readonly epoch: number;
  readonly seq: number;
  readonly holds: { released: boolean; cutShort: number };
}

export const ANY_SESSION = "*";

export interface IncompleteParentTurn {
  readonly turnId: string;
  readonly servedThrough: number;
  readonly totalSteps: number;
  readonly registeredAt: string;
}

function incompleteParentTurnCell(): Map<string, IncompleteParentTurn> {
  return processRegistryMap<IncompleteParentTurn>("scripted-model-incomplete-parent-turn.v1");
}

function noteIfParentTurnIncomplete(entry: ScriptedEntry): void {
  const totalSteps = entry.script.parent.length;
  if (totalSteps === 0) return;
  const bySession = new Map<string, RecordedRequest[]>();
  for (const r of entry.requests) {
    if (r.role !== "parent" || r.sessionId === undefined || r.turnId === undefined || r.fault !== undefined) continue;
    const list = bySession.get(r.sessionId);
    if (list === undefined) bySession.set(r.sessionId, [r]);
    else list.push(r);
  }
  const owners = incompleteParentTurnCell();
  for (const [sid, reqs] of bySession) {
    const lastTurnId = reqs[reqs.length - 1].turnId as string;
    const sameTurn = reqs.filter((r) => r.turnId === lastTurnId);
    const maxServed = Math.max(...sameTurn.map((r) => r.stepIndex));
    if (maxServed < totalSteps - 1) {
      owners.set(sid, { turnId: lastTurnId, servedThrough: maxServed, totalSteps, registeredAt: entry.registeredAt });
    } else {
      owners.delete(sid);
    }
  }
}

export function incompleteParentTurnFor(sessionId: string): IncompleteParentTurn | undefined {
  return incompleteParentTurnCell().get(sessionId);
}

export function clearIncompleteParentTurn(sessionId: string): void {
  incompleteParentTurnCell().delete(sessionId);
}

function epochCell(): Map<string, number> {
  return processRegistryMap<number>("scripted-model-epoch.v1");
}

export function scriptedEpoch(): number {
  return epochCell().get("n") ?? 0;
}

export function beginScriptedEpoch(): void {
  epochCell().set("n", scriptedEpoch() + 1);
}

function seqCell(): Map<string, number> {
  return processRegistryMap<number>("scripted-model-seq.v1");
}

export function scriptedRegistrationSeq(): number {
  return seqCell().get("n") ?? 0;
}

function nextRegistrationSeq(): number {
  const next = scriptedRegistrationSeq() + 1;
  seqCell().set("n", next);
  return next;
}

export const STALE_TURN_PARK_MS = 30_000;

export function staleTurnParkMs(): number {
  return processRegistryMap<number>("scripted-model-park.v1").get("ms") ?? STALE_TURN_PARK_MS;
}

export function __setStaleTurnParkMsForTest(ms: number | undefined): void {
  const cell = processRegistryMap<number>("scripted-model-park.v1");
  if (ms === undefined) cell.delete("ms");
  else cell.set("ms", ms);
}

interface StaleHoldExpiry {
  readonly sessionId: string;
  readonly heldTurnId: string;
  readonly scriptTurnId: string;
  readonly registeredAt: string;
  readonly parkMs: number;
}

function staleHoldExpiries(): Map<string, StaleHoldExpiry> {
  return processRegistryMap<StaleHoldExpiry>("scripted-model-stale-expiry.v1");
}

export function noteStaleHoldExpiry(expiry: StaleHoldExpiry): void {
  staleHoldExpiries().set(`${expiry.sessionId}/${expiry.heldTurnId}`, expiry);
}

export function __resetStaleHoldExpiriesForTest(): void {
  staleHoldExpiries().clear();
}

export function staleHoldExpiryNote(): string {
  const all = [...staleHoldExpiries().values()];
  if (all.length === 0) return "";
  const each = all
    .map(
      (e) =>
        `session ${e.sessionId}, held turn "${e.heldTurnId}", waited ${e.parkMs}ms against the script ` +
        `registered by ${e.registeredAt} for turn "${e.scriptTurnId}"`,
    )
    .join("; ");
  return (
    ` — 🔴 CAUSE: ${all.length} STALE-TURN HOLD(S) EXPIRED in this fork (OPE-750/OPE-777): ${each}. ` +
    "A settlement turn reached a script its test had not yet replaced, waited for the replacement, and " +
    "gave up — so its reply was DROPPED and the wait above could never resolve. This is a TEST-HARNESS " +
    "ordering defect, not a product hang. Fix the test: call `armSettlement` BEFORE the long wait that " +
    "precedes the swap (harness.ts), or swap scripts inside the same test rather than after it."
  );
}

export function scriptedStore(): Map<string, ScriptedEntry> {
  return processRegistryMap<ScriptedEntry>("scripted-model.v1");
}

export interface ScriptedHandle {
  readonly requests: readonly RecordedRequest[];
  readonly resolves: readonly ResolveObservation[];
  dispose(): void;
  releaseHolds(): void;
  holdsCutShort(): number;
}

function callerFrame(): string {
  const stack = new Error().stack;
  if (stack === undefined) return "an unknown caller (no stack)";
  for (const line of stack.split("\n").slice(1)) {
    if (line.includes("scripted-model")) continue;
    const at = line.trim();
    if (at.startsWith("at ")) return at.slice(3);
  }
  return "an unknown caller (no frame outside scripted-model.ts)";
}

export function registerScript(script: SeatScript, sessionId: string = ANY_SESSION): ScriptedHandle {
  if (!scriptedModelArmed()) {
    throw new Error(
      `open-everywhere: registerScript called without ${SCRIPTED_MODEL_ENV}=1. ` +
        "Arm the process before the agent boots, or this script can never answer a model call.",
    );
  }
  const store = scriptedStore();
  const held = store.get(sessionId);
  if (held !== undefined) {
    throw new Error(
      `open-everywhere: a script is already registered for "${sessionId}", by ${held.registeredAt}. ` +
        "Dispose the previous handle first — two live scripts for one key means a test leaked.",
    );
  }
  const entry: ScriptedEntry = {
    script,
    requests: [],
    resolves: [],
    baselines: {},
    firstCallTurnByRole: {},
    registeredAt: callerFrame(),
    epoch: scriptedEpoch(),
    seq: nextRegistrationSeq(),
    holds: { released: false, cutShort: 0 },
  };
  store.set(sessionId, entry);
  return {
    requests: entry.requests,
    resolves: entry.resolves,
    releaseHolds: () => {
      entry.holds.released = true;
    },
    holdsCutShort: () => entry.holds.cutShort,
    dispose: () => {
      if (store.get(sessionId) === entry) {
        store.delete(sessionId);
        noteIfParentTurnIncomplete(entry);
      }
    },
  };
}
