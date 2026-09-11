import { defineState } from "eve/context";

interface PendingDelegation {
  readonly taskId: string;
  readonly parentWakeId?: string;
}

interface PendingDelegationState {
  readonly turn?: string;
  readonly pending?: readonly PendingDelegation[];
}

const slot = defineState<PendingDelegationState>("open-everywhere.pending-delegation", () => ({}));

interface PromisedReportState {
  readonly promised?: readonly string[];
}

const promisedSlot = defineState<PromisedReportState>("open-everywhere.delegation-report-promised", () => ({}));

interface ReportOwedState {
  readonly turn?: string;
  readonly task?: string;
  readonly wake?: string;
  readonly refused?: boolean;
}

const owedSlot = defineState<ReportOwedState>("open-everywhere.delegation-report-owed", () => ({}));

const MAX_PENDING = 16;

export const DELEGATION_PENDING_REFUSAL_REASON = "delegation-pending";

export const BRIDGE_WAKE_HELD_AUDIT_ACTION = "turn.direct_mention_bridge_wake_held";

export const SETTLEMENT_REPORT_POSTED_ACTION = "delegation.settlement_report_posted";

export const SETTLEMENT_REPORT_SKIPPED_ACTION = "delegation.settlement_report_skipped";

export function delegationPendingRefusalMessage(): string {
  return (
    "reply: NOTHING was posted. You started a background worker for this conversation in this turn, " +
    "and its report has not arrived. You therefore do not hold the answer it was asked for. " +
    "Do not write that answer from what you believe you know — that is a fabrication, even when it " +
    "looks right. Post a short hand-off note with `done:false` instead. That keeps this wake " +
    "answerable, so you can give the real answer the moment the worker's own report reaches you."
  );
}

export function settlementReportOwedMessage(): string {
  return (
    "no_reply: nothing was recorded. You told this conversation you had started this work, and the " +
    "worker's report has now arrived — that is what woke this turn. The people waiting are waiting " +
    "for you to relay it, so post it with `reply`: what the worker found, in your own words. " +
    "This is your own commissioned work coming back, never machine echo."
  );
}

function readState(v: unknown): PendingDelegationState {
  if (v === null || typeof v !== "object") return {};
  const s = v as { turn?: unknown; pending?: unknown };
  if (typeof s.turn !== "string" || s.turn.length === 0) return {};
  const pending = Array.isArray(s.pending)
    ? s.pending.flatMap((t): PendingDelegation[] => {
        if (typeof t !== "object" || t === null) return [];
        const raw = t as { taskId?: unknown; parentWakeId?: unknown };
        if (typeof raw.taskId !== "string" || raw.taskId.length === 0) return [];
        return [
          {
            taskId: raw.taskId,
            ...(typeof raw.parentWakeId === "string" && raw.parentWakeId.length > 0 ? { parentWakeId: raw.parentWakeId } : {}),
          },
        ];
      })
    : [];
  return { turn: s.turn, pending };
}

export function notePendingDelegation(turnId: string | undefined, taskId: string, parentWakeId: string | undefined): void {
  if (turnId === undefined || turnId.length === 0) return;
  if (taskId.length === 0) return;
  const entry: PendingDelegation = { taskId, ...(parentWakeId !== undefined && parentWakeId.length > 0 ? { parentWakeId } : {}) };
  try {
    slot.update((cur) => {
      const state = readState(cur);
      if (state.turn !== turnId) return { turn: turnId, pending: [entry] };
      const pending = state.pending ?? [];
      if (pending.length >= MAX_PENDING || pending.some((t) => t.taskId === taskId)) return state;
      return { turn: turnId, pending: [...pending, entry] };
    });
  } catch {
  }
}

export function noteDelegationSettled(turnId: string | undefined, taskId: string): void {
  if (turnId === undefined || turnId.length === 0) return;
  if (taskId.length === 0) return;
  try {
    slot.update((cur) => {
      const state = readState(cur);
      if (state.turn !== turnId) return state;
      const pending = state.pending ?? [];
      if (!pending.some((t) => t.taskId === taskId)) return state;
      return { turn: turnId, pending: pending.filter((t) => t.taskId !== taskId) };
    });
  } catch {
  }
}

export function pendingDelegationOwing(turnId: string | undefined, wakeId: string, addressedWake: string | undefined): string | undefined {
  return pendingDelegationsOwing(turnId, wakeId, addressedWake)[0];
}

export function pendingDelegationThisTurn(turnId: string | undefined): string | undefined {
  if (turnId === undefined || turnId.length === 0) return undefined;
  let state: PendingDelegationState;
  try {
    state = readState(slot.get());
  } catch {
    return undefined;
  }
  if (state.turn !== turnId) return undefined;
  return (state.pending ?? [])[0]?.taskId;
}

export function pendingDelegationsOwing(turnId: string | undefined, wakeId: string, addressedWake: string | undefined): readonly string[] {
  if (turnId === undefined || turnId.length === 0) return [];
  if (wakeId.length === 0) return [];
  let state: PendingDelegationState;
  try {
    state = readState(slot.get());
  } catch {
    return [];
  }
  if (state.turn !== turnId) return [];
  const pending = state.pending ?? [];
  if (pending.length === 0) return [];
  const named = pending.filter((t) => t.parentWakeId === wakeId);
  if (named.length > 0) return named.map((t) => t.taskId);
  if (addressedWake === undefined) return pending.map((t) => t.taskId);
  if (addressedWake === wakeId) return pending.map((t) => t.taskId);
  return [];
}

const MAX_PROMISED = 32;

export function notePromisedReport(taskId: string): void {
  if (taskId.length === 0) return;
  try {
    promisedSlot.update((cur) => {
      const promised = readPromised(cur);
      if (promised.includes(taskId)) return { promised };
      const next = [...promised, taskId];
      return { promised: next.length > MAX_PROMISED ? next.slice(next.length - MAX_PROMISED) : next };
    });
  } catch {
  }
}

export function claimPromisedReport(taskId: string): boolean {
  if (taskId.length === 0) return false;
  try {
    let held = false;
    promisedSlot.update((cur) => {
      const promised = readPromised(cur);
      held = promised.includes(taskId);
      return held ? { promised: promised.filter((t) => t !== taskId) } : { promised };
    });
    return held;
  } catch {
    return false;
  }
}

export function noteSettlementReportOwed(turnId: string | undefined, taskId: string, wakeId: string | undefined): void {
  if (turnId === undefined || turnId.length === 0) return;
  if (taskId.length === 0) return;
  if (wakeId === undefined || wakeId.length === 0) return;
  try {
    owedSlot.update(() => ({ turn: turnId, task: taskId, wake: wakeId }));
  } catch {
  }
}

function settlementReportOwed(turnId: string | undefined): { readonly task: string; readonly wake: string } | undefined {
  if (turnId === undefined || turnId.length === 0) return undefined;
  try {
    const state = owedSlot.get() as ReportOwedState | null;
    if (state === null || typeof state !== "object") return undefined;
    if (state.turn !== turnId) return undefined;
    const { task, wake } = state;
    if (typeof task !== "string" || task.length === 0) return undefined;
    if (typeof wake !== "string" || wake.length === 0) return undefined;
    return { task, wake };
  } catch {
    return undefined;
  }
}

export function settlementReportOwedOn(turnId: string | undefined): { readonly task: string; readonly wake: string } | undefined {
  return settlementReportOwed(turnId);
}

export function dischargeSettlementReport(): void {
  clearReportOwed();
}

export function refuseSettlementReport(turnId: string | undefined): string | undefined {
  if (turnId === undefined || turnId.length === 0) return undefined;
  const owed = settlementReportOwed(turnId);
  if (owed === undefined) return undefined;
  try {
    const already = (owedSlot.get() as ReportOwedState | null)?.refused === true;
    if (already) {
      clearReportOwed();
      return undefined;
    }
    owedSlot.update(() => ({ turn: turnId, task: owed.task, wake: owed.wake, refused: true }));
    return owed.task;
  } catch {
    return undefined;
  }
}

function clearReportOwed(): void {
  try {
    owedSlot.update(() => ({}));
  } catch {
  }
}

function readPromised(v: unknown): readonly string[] {
  if (v === null || typeof v !== "object") return [];
  const raw = (v as { promised?: unknown }).promised;
  if (!Array.isArray(raw)) return [];
  return raw.filter((t): t is string => typeof t === "string" && t.length > 0);
}
