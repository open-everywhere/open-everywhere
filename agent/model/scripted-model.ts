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

export const WAKE_FROM_ENVELOPE = "<wake-from-envelope>";

export function wakeIdFromPrompt(messages: readonly { readonly text: string }[]): string | undefined {
  let found: string | undefined;
  for (const m of messages) {
    for (const match of m.text.matchAll(/<wake\b[^>]*\bwake-id="([^"]+)"/g)) found = match[1];
  }
  return found;
}

export const WAKE_FROM_REPORT = "<wake-from-report>";

export function wakeIdFromReport(messages: readonly { readonly text: string }[]): string | undefined {
  let found: string | undefined;
  for (const m of messages) {
    for (const match of m.text.matchAll(/^for wake ([^\s<>]+)[ \t]*$/gm)) found = match[1];
  }
  return found;
}

export function fillWakePlaceholder(input: unknown, wakeId: string | undefined): { readonly value: unknown; readonly unresolved: boolean } {
  return fillOnePlaceholder(input, WAKE_FROM_ENVELOPE, wakeId);
}

export function fillReportWakePlaceholder(input: unknown, wakeId: string | undefined): { readonly value: unknown; readonly unresolved: boolean } {
  return fillOnePlaceholder(input, WAKE_FROM_REPORT, wakeId);
}

function fillOnePlaceholder(input: unknown, placeholder: string, wakeId: string | undefined): { readonly value: unknown; readonly unresolved: boolean } {
  if (input === undefined || !JSON.stringify(input)?.includes(placeholder)) return { value: input, unresolved: false };
  let unresolved = false;
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      if (!node.includes(placeholder)) return node;
      if (wakeId === undefined) {
        unresolved = true;
        return node;
      }
      return node.split(placeholder).join(wakeId);
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = walk(v);
      return out;
    }
    return node;
  };
  return { value: walk(input), unresolved };
}

export function unresolvedWakePlaceholderFault(tool: string): string {
  return (
    `scripted model: step called "${tool}" with ${WAKE_FROM_ENVELOPE}, but the served prompt carries no ` +
    "`<wake wake-id=…>` envelope. A native per-container session mints no wake id — only a standing " +
    "seat's rendered envelope does — so this script is scripting a seat shape the wake never had."
  );
}

export function unresolvedReportWakePlaceholderFault(tool: string): string {
  return (
    `scripted model: step called "${tool}" with ${WAKE_FROM_REPORT}, but no served message carries a ` +
    "`for wake <id>` line on its own line. A settlement report names the wake that dispatched the " +
    "worker (OPE-2133); a prompt without that line means the worker's persona rendered no address."
  );
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
  readonly id: string;
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
  readonly sequence: number;
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
  readonly redriveSilence?: boolean;
  readonly foreignWakeSilence?: boolean;
}

export function nextScriptedRequestSequence(): number {
  const cell = processRegistryMap<number>("scripted-model-request-sequence.v1");
  const next = (cell.get("n") ?? 0) + 1;
  cell.set("n", next);
  return next;
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
  readonly firstCallWakeByRole: Partial<Record<ScriptedRole, string>>;
  readonly registeredAt: string;
  readonly epoch: number;
  readonly seq: number;
  readonly absorbsStragglers: boolean;
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

function wakeOwnerCell(): Map<string, number> {
  return processRegistryMap<number>("scripted-model-wake-owner.v1");
}

export function wakeOwnerSeq(wakeId: string): number | undefined {
  return wakeOwnerCell().get(wakeId);
}

export function claimWakeOwner(wakeId: string, seq: number): void {
  const cell = wakeOwnerCell();
  if (!cell.has(wakeId)) cell.set(wakeId, seq);
}

export function __resetWakeOwnersForTest(): void {
  wakeOwnerCell().clear();
}

export interface ForeignWakeCheck {
  readonly role: ScriptedRole;
  readonly wildcard: boolean;
  readonly callBearing: boolean;
  readonly absorbsStragglers: boolean;
  readonly wakeId: string | undefined;
  readonly ownerSeq: number | undefined;
  readonly seq: number;
}

export function isForeignWakeStraggler(check: ForeignWakeCheck): boolean {
  if (check.role !== "parent") return false;
  if (!check.wildcard) return false;
  if (!check.callBearing) return false;
  if (check.absorbsStragglers) return false;
  if (check.wakeId === undefined) return false;
  if (check.ownerSeq === undefined) return false;
  return check.ownerSeq !== check.seq;
}

interface ForeignWakeSilence {
  readonly sessionId: string;
  readonly turnId: string;
  readonly wakeId: string;
  readonly ownerSeq: number;
  readonly registeredAt: string;
}

function foreignWakeSilences(): Map<string, ForeignWakeSilence> {
  return processRegistryMap<ForeignWakeSilence>("scripted-model-foreign-wake.v1");
}

export function noteForeignWakeSilence(silence: ForeignWakeSilence): void {
  foreignWakeSilences().set(`${silence.sessionId}/${silence.turnId}`, silence);
}

export function __resetForeignWakeSilencesForTest(): void {
  foreignWakeSilences().clear();
}

export function foreignWakeSilenceNote(): string {
  const all = [...foreignWakeSilences().values()];
  if (all.length === 0) return "";
  const each = all
    .map((s) => `session ${s.sessionId}, turn "${s.turnId}", wake "${s.wakeId}" owned by registration #${s.ownerSeq}`)
    .join("; ");
  return (
    ` — ⚠️ ALSO: the OPE-2240 foreign-wake fence answered ${all.length} straggler turn(s) with judged ` +
    `silence in this fork: ${each}. Each one carried a wake a DIFFERENT registration had already served, ` +
    "and reached a later WILDCARD script's call-bearing step, so it spent no step of it. That is the " +
    "intended outcome for a leg that is over. If the wait above wanted one of these turns, the script " +
    "for it must be registered on that SESSION's own id (harness.ts's `armSettlement`), not on the wildcard."
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

export interface RegisterScriptOptions {
  readonly absorbsStragglers?: boolean;
}

export function registerScript(script: SeatScript, sessionId: string = ANY_SESSION, opts: RegisterScriptOptions = {}): ScriptedHandle {
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
    firstCallWakeByRole: {},
    registeredAt: callerFrame(),
    epoch: scriptedEpoch(),
    seq: nextRegistrationSeq(),
    absorbsStragglers: opts.absorbsStragglers === true,
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
        if (!entry.absorbsStragglers) noteIfParentTurnIncomplete(entry);
      }
    },
  };
}
