import { defineState } from "eve/context";
import { parseWorkCancels, parseWorkRequests } from "../channels/work.js";

export interface OpenWorkRequest {
  readonly requestId: string;
  readonly brief: string;
  readonly taskId?: string;
}

export type WorkCallJoin =
  | { readonly kind: "joined"; readonly requestId: string; readonly by: "single" | "brief" }
  | { readonly kind: "refused"; readonly reason: "no-match" | "tied" }
  | { readonly kind: "none-open" };

export const WORK_REQUEST_UNJOINABLE_MESSAGE =
  "agent: this turn holds more than one forwarded job, and this call's message is not exactly one job's text. " +
  "It was NOT started. Call `agent` once per <work-request> block, with that block's text verbatim as the message.";

export function joinWorkCall(open: readonly OpenWorkRequest[], message: unknown): WorkCallJoin {
  if (open.length === 0) return { kind: "none-open" };
  if (open.length === 1) return { kind: "joined", requestId: open[0]!.requestId, by: "single" };
  if (typeof message !== "string") return { kind: "refused", reason: "no-match" };
  const matches = open.filter((r) => r.brief === message);
  if (matches.length === 0) return { kind: "refused", reason: "no-match" };
  if (new Set(matches.map((r) => r.requestId)).size > 1) return { kind: "refused", reason: "tied" };
  return { kind: "joined", requestId: matches[0]!.requestId, by: "brief" };
}

const MAX_OPEN = 16;

interface WorkCallClaim {
  readonly message: string;
  readonly requestId: string;
}

interface WorkRequestTurnState {
  readonly turn?: string;
  readonly open?: readonly OpenWorkRequest[];
  readonly claims?: readonly WorkCallClaim[];
  readonly retired?: readonly string[];
  readonly started?: readonly string[];
  readonly cancels?: readonly string[];
  readonly ended?: boolean;
}

const slot = defineState<WorkRequestTurnState>("open-everywhere.work-requests-turn", () => ({}));

function readState(v: unknown): WorkRequestTurnState {
  if (v === null || typeof v !== "object") return {};
  const s = v as { turn?: unknown; open?: unknown; claims?: unknown; retired?: unknown; started?: unknown; cancels?: unknown; ended?: unknown };
  if (typeof s.turn !== "string" || s.turn.length === 0) return {};
  const open = Array.isArray(s.open)
    ? s.open
        .filter(
          (r): r is OpenWorkRequest =>
            typeof r === "object" && r !== null && typeof (r as OpenWorkRequest).requestId === "string" && typeof (r as OpenWorkRequest).brief === "string",
        )
        .map((r) => ({ requestId: r.requestId, brief: r.brief, ...(typeof r.taskId === "string" && r.taskId.length > 0 ? { taskId: r.taskId } : {}) }))
    : [];
  const claims = Array.isArray(s.claims)
    ? s.claims.filter(
        (c): c is WorkCallClaim =>
          typeof c === "object" && c !== null && typeof (c as WorkCallClaim).message === "string" && typeof (c as WorkCallClaim).requestId === "string",
      )
    : [];
  const retired = Array.isArray(s.retired) ? s.retired.filter((id): id is string => typeof id === "string") : [];
  const started = Array.isArray(s.started) ? s.started.filter((id): id is string => typeof id === "string") : [];
  const cancels = Array.isArray(s.cancels) ? s.cancels.filter((id): id is string => typeof id === "string") : [];
  return {
    turn: s.turn,
    open,
    claims,
    ...(retired.length > 0 ? { retired } : {}),
    ...(started.length > 0 ? { started } : {}),
    ...(cancels.length > 0 ? { cancels } : {}),
    ...(s.ended === true ? { ended: true } : {}),
  };
}

export function recordWorkRequestsThisTurn(turnId: string | undefined, message: string | undefined): void {
  if (turnId === undefined || turnId.length === 0 || message === undefined) return;
  const incoming: OpenWorkRequest[] = parseWorkRequests(message).map((r) => ({ requestId: r.requestId, brief: r.brief, ...(r.taskId !== undefined ? { taskId: r.taskId } : {}) }));
  const incomingCancels = parseWorkCancels(message).map((c) => c.taskId);
  if (incoming.length === 0 && incomingCancels.length === 0) return;
  try {
    slot.update((cur) => {
      const state = readState(cur);
      const same = state.turn === turnId;
      const prior = same ? (state.open ?? []) : [];
      const open = [...prior];
      let retired = same ? (state.retired ?? []) : [];
      const started = same ? (state.started ?? []) : [];
      for (const r of incoming) {
        if (retired.includes(r.requestId)) retired = retired.filter((id) => id !== r.requestId);
        if (open.some((o) => o.requestId === r.requestId)) continue;
        if (open.length >= MAX_OPEN) {
          console.warn(`[open-everywhere:work] request ${r.requestId} NOT recorded for turn ${turnId}: the turn already holds ${MAX_OPEN} forwarded jobs — its call will be refused`);
          continue;
        }
        open.push(r);
      }
      const cancels = [...(same ? (state.cancels ?? []) : [])];
      for (const taskId of incomingCancels) if (!cancels.includes(taskId)) cancels.push(taskId);
      return {
        turn: turnId,
        open,
        claims: same ? (state.claims ?? []) : [],
        ...(retired.length > 0 ? { retired } : {}),
        ...(started.length > 0 ? { started } : {}),
        ...(cancels.length > 0 ? { cancels } : {}),
      };
    });
  } catch {
  }
}

function decideWorkCallJoin(state: WorkRequestTurnState, message: unknown, stamp: string | undefined): { readonly result: WorkCallJoin; readonly claim?: WorkCallClaim } {
  const open = state.open ?? [];
  const claims = state.claims ?? [];
  if (open.length === 0) return { result: { kind: "none-open" } };
  const claimed = new Set(claims.map((c) => c.requestId));
  const retired = new Set(state.retired ?? []);
  if (stamp !== undefined && typeof message === "string" && !retired.has(stamp) && open.some((r) => r.requestId === stamp && r.brief === message)) {
    const result: WorkCallJoin = { kind: "joined", requestId: stamp, by: "brief" };
    return claims.some((c) => c.requestId === stamp) ? { result } : { result, claim: { message, requestId: stamp } };
  }
  const priors = typeof message === "string" ? claims.filter((c) => c.message === message) : [];
  const prior = priors.find((c) => c.requestId === stamp) ?? priors[0];
  if (prior !== undefined) return { result: { kind: "joined", requestId: prior.requestId, by: "brief" } };
  const unclaimed = open.filter((r) => !claimed.has(r.requestId) && !retired.has(r.requestId));
  if (typeof message === "string" && !unclaimed.some((r) => r.brief === message) && open.some((r) => retired.has(r.requestId) && r.brief === message)) {
    return { result: { kind: "refused", reason: "no-match" } };
  }
  const result: WorkCallJoin = unclaimed.length === 0 ? { kind: "refused", reason: "no-match" } : joinWorkCall(unclaimed, message);
  if (result.kind !== "joined" || typeof message !== "string") return { result };
  return { result, claim: { message, requestId: result.requestId } };
}

export function claimWorkCall(turnId: string | undefined, message: unknown, stamp?: string): WorkCallJoin {
  if (turnId === undefined || turnId.length === 0) return { kind: "none-open" };
  let result: WorkCallJoin = { kind: "none-open" };
  try {
    slot.update((cur) => {
      const state = readState(cur);
      if (state.turn !== turnId) return cur as WorkRequestTurnState;
      const decided = decideWorkCallJoin(state, message, stamp);
      result = decided.result;
      if (decided.claim === undefined) return cur as WorkRequestTurnState;
      return { ...state, claims: [...(state.claims ?? []), decided.claim] };
    });
  } catch {
    return { kind: "none-open" };
  }
  return result;
}

/** The job `claimWorkCall` joins (or joined) this call to, read without taking a claim. */
export function peekWorkCallJoin(turnId: string | undefined, message: unknown, stamp?: string): WorkCallJoin {
  if (turnId === undefined || turnId.length === 0) return { kind: "none-open" };
  try {
    const state = readState(slot.get());
    if (state.turn !== turnId) return { kind: "none-open" };
    return decideWorkCallJoin(state, message, stamp).result;
  } catch {
    return { kind: "none-open" };
  }
}

export function workCallClaimed(turnId: string | undefined, message: unknown): boolean {
  if (turnId === undefined || turnId.length === 0 || typeof message !== "string") return false;
  try {
    const state = readState(slot.get());
    return state.turn === turnId && (state.claims ?? []).some((c) => c.message === message);
  } catch {
    return false;
  }
}

export function releaseWorkCall(turnId: string | undefined, message: unknown): void {
  if (turnId === undefined || turnId.length === 0 || typeof message !== "string") return;
  try {
    slot.update((cur) => {
      const state = readState(cur);
      if (state.turn !== turnId) return cur as WorkRequestTurnState;
      return { ...state, claims: (state.claims ?? []).filter((c) => c.message !== message) };
    });
  } catch {
  }
}

export function retireWorkRequest(turnId: string | undefined, requestId: string): void {
  if (turnId === undefined || turnId.length === 0) return;
  try {
    slot.update((cur) => {
      const state = readState(cur);
      if (state.turn !== turnId) return cur as WorkRequestTurnState;
      const retired = state.retired ?? [];
      return {
        ...state,
        claims: (state.claims ?? []).filter((c) => c.requestId !== requestId),
        retired: retired.includes(requestId) ? retired : [...retired, requestId],
      };
    });
  } catch {
  }
}

export function workRequestNamesTask(turnId: string | undefined, requestId: string | undefined, taskId: string): boolean {
  if (requestId === undefined || requestId.length === 0 || taskId.length === 0) return false;
  return workRequestsThisTurn(turnId).some((r) => r.requestId === requestId && r.taskId === taskId);
}

export function workRequestsThisTurn(turnId: string | undefined): readonly OpenWorkRequest[] {
  if (turnId === undefined || turnId.length === 0) return [];
  try {
    const state = readState(slot.get());
    return state.turn === turnId ? (state.open ?? []) : [];
  } catch {
    return [];
  }
}

export function noteWorkRequestStarted(turnId: string | undefined, requestId: string): void {
  if (turnId === undefined || turnId.length === 0 || requestId.length === 0) return;
  try {
    slot.update((cur) => {
      const state = readState(cur);
      if (state.turn !== turnId) return cur as WorkRequestTurnState;
      const started = state.started ?? [];
      return started.includes(requestId) ? (cur as WorkRequestTurnState) : { ...state, started: [...started, requestId] };
    });
  } catch {
  }
}

export function workRequestStarted(turnId: string | undefined, requestId: string): boolean {
  if (turnId === undefined || turnId.length === 0) return false;
  try {
    const state = readState(slot.get());
    return state.turn === turnId && (state.started ?? []).includes(requestId);
  } catch {
    return false;
  }
}

export function noteWorkCancelHandled(turnId: string | undefined, taskId: string): void {
  if (turnId === undefined || turnId.length === 0) return;
  try {
    slot.update((cur) => {
      const state = readState(cur);
      if (state.turn !== turnId || !(state.cancels ?? []).includes(taskId)) return cur as WorkRequestTurnState;
      const cancels = (state.cancels ?? []).filter((id) => id !== taskId);
      const { cancels: _old, ...rest } = state;
      return cancels.length > 0 ? { ...rest, cancels } : rest;
    });
  } catch {
  }
}

export interface WorkTurnSettled {
  readonly first: boolean;
  readonly jobs: number;
}

export function workTurnSettled(turnId: string | undefined): WorkTurnSettled | undefined {
  if (turnId === undefined || turnId.length === 0) return undefined;
  let verdict: WorkTurnSettled | undefined;
  try {
    slot.update((cur) => {
      const state = readState(cur);
      const open = state.open ?? [];
      if (state.turn !== turnId || open.length === 0 || (state.cancels ?? []).length > 0) return cur as WorkRequestTurnState;
      const done = new Set([...(state.started ?? []), ...(state.retired ?? [])]);
      if (!open.every((r) => done.has(r.requestId))) return cur as WorkRequestTurnState;
      verdict = { first: state.ended !== true, jobs: open.length };
      return state.ended === true ? (cur as WorkRequestTurnState) : { ...state, ended: true };
    });
  } catch {
    return undefined;
  }
  return verdict;
}

export const WORK_REQUEST_ALREADY_STARTED_MESSAGE =
  "agent: this job already started in this turn, and its result goes back to the conversation by itself when it settles. " +
  "It was NOT started again. Do not call `agent` for it again: end your turn.";
