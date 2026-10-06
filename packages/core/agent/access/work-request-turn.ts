import { defineState } from "eve/context";
import { parseWorkRequests } from "../channels/work.js";

export interface OpenWorkRequest {
  readonly requestId: string;
  readonly brief: string;
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
}

const slot = defineState<WorkRequestTurnState>("open-everywhere.work-requests-turn", () => ({}));

function readState(v: unknown): WorkRequestTurnState {
  if (v === null || typeof v !== "object") return {};
  const s = v as { turn?: unknown; open?: unknown; claims?: unknown; retired?: unknown };
  if (typeof s.turn !== "string" || s.turn.length === 0) return {};
  const open = Array.isArray(s.open)
    ? s.open.filter(
        (r): r is OpenWorkRequest =>
          typeof r === "object" && r !== null && typeof (r as OpenWorkRequest).requestId === "string" && typeof (r as OpenWorkRequest).brief === "string",
      )
    : [];
  const claims = Array.isArray(s.claims)
    ? s.claims.filter(
        (c): c is WorkCallClaim =>
          typeof c === "object" && c !== null && typeof (c as WorkCallClaim).message === "string" && typeof (c as WorkCallClaim).requestId === "string",
      )
    : [];
  const retired = Array.isArray(s.retired) ? s.retired.filter((id): id is string => typeof id === "string") : [];
  return { turn: s.turn, open, claims, ...(retired.length > 0 ? { retired } : {}) };
}

export function recordWorkRequestsThisTurn(turnId: string | undefined, message: string | undefined): void {
  if (turnId === undefined || turnId.length === 0 || message === undefined) return;
  const incoming = parseWorkRequests(message).map((r) => ({ requestId: r.requestId, brief: r.brief }));
  if (incoming.length === 0) return;
  try {
    slot.update((cur) => {
      const state = readState(cur);
      const prior = state.turn === turnId ? (state.open ?? []) : [];
      const open = [...prior];
      let retired = state.turn === turnId ? (state.retired ?? []) : [];
      for (const r of incoming) {
        if (retired.includes(r.requestId)) retired = retired.filter((id) => id !== r.requestId);
        if (open.some((o) => o.requestId === r.requestId)) continue;
        if (open.length >= MAX_OPEN) {
          console.warn(`[open-everywhere:work] request ${r.requestId} NOT recorded for turn ${turnId}: the turn already holds ${MAX_OPEN} forwarded jobs — its call will be refused`);
          continue;
        }
        open.push(r);
      }
      return { turn: turnId, open, claims: state.turn === turnId ? (state.claims ?? []) : [], ...(retired.length > 0 ? { retired } : {}) };
    });
  } catch {
  }
}

export function claimWorkCall(turnId: string | undefined, message: unknown, stamp?: string): WorkCallJoin {
  if (turnId === undefined || turnId.length === 0) return { kind: "none-open" };
  let result: WorkCallJoin = { kind: "none-open" };
  try {
    slot.update((cur) => {
      const state = readState(cur);
      if (state.turn !== turnId) return cur as WorkRequestTurnState;
      const open = state.open ?? [];
      const claims = state.claims ?? [];
      if (open.length === 0) return cur as WorkRequestTurnState;
      const claimed = new Set(claims.map((c) => c.requestId));
      const retired = new Set(state.retired ?? []);
      if (stamp !== undefined && typeof message === "string" && !retired.has(stamp) && open.some((r) => r.requestId === stamp && r.brief === message)) {
        result = { kind: "joined", requestId: stamp, by: "brief" };
        if (claims.some((c) => c.requestId === stamp)) return cur as WorkRequestTurnState;
        return { ...state, claims: [...claims, { message, requestId: stamp }] };
      }
      const priors = typeof message === "string" ? claims.filter((c) => c.message === message) : [];
      const prior = priors.find((c) => c.requestId === stamp) ?? priors[0];
      if (prior !== undefined) {
        result = { kind: "joined", requestId: prior.requestId, by: "brief" };
        return cur as WorkRequestTurnState;
      }
      const unclaimed = open.filter((r) => !claimed.has(r.requestId) && !retired.has(r.requestId));
      if (
        typeof message === "string" &&
        !unclaimed.some((r) => r.brief === message) &&
        open.some((r) => retired.has(r.requestId) && r.brief === message)
      ) {
        result = { kind: "refused", reason: "no-match" };
        return cur as WorkRequestTurnState;
      }
      result = unclaimed.length === 0 ? { kind: "refused", reason: "no-match" } : joinWorkCall(unclaimed, message);
      if (result.kind !== "joined" || typeof message !== "string") return cur as WorkRequestTurnState;
      return { ...state, claims: [...claims, { message, requestId: result.requestId }] };
    });
  } catch {
    return { kind: "none-open" };
  }
  return result;
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

export function workRequestsThisTurn(turnId: string | undefined): readonly OpenWorkRequest[] {
  if (turnId === undefined || turnId.length === 0) return [];
  try {
    const state = readState(slot.get());
    return state.turn === turnId ? (state.open ?? []) : [];
  } catch {
    return [];
  }
}
