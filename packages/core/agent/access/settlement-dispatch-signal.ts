import { defineState } from "eve/context";
import { isRequesterVerdict, type RequesterVerdict } from "./requester-identity.js";

export interface SettlementDispatchAuthority {
  readonly wakeId: string;
  readonly requester: RequesterVerdict;
  readonly nonMemberWake: boolean;
}

interface SettlementDispatchState {
  readonly turn?: string;
  readonly taskId?: string;
  readonly authority?: SettlementDispatchAuthority;
  readonly blocked?: boolean;
}

const slot = defineState<SettlementDispatchState>("open-everywhere.settlement-dispatch-authority", () => ({}));

function validAuthority(value: unknown): value is SettlementDispatchAuthority {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const authority = value as Record<string, unknown>;
  return (
    typeof authority.wakeId === "string" &&
    authority.wakeId.length > 0 &&
    isRequesterVerdict(authority.requester) &&
    typeof authority.nonMemberWake === "boolean"
  );
}

function readState(value: unknown): SettlementDispatchState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const state = value as Record<string, unknown>;
  if (typeof state.turn !== "string" || state.turn.length === 0) return {};
  const taskId = typeof state.taskId === "string" && state.taskId.length > 0 ? state.taskId : undefined;
  const authority = validAuthority(state.authority) ? state.authority : undefined;
  return {
    turn: state.turn,
    ...(taskId !== undefined ? { taskId } : {}),
    ...(authority !== undefined ? { authority } : {}),
    ...(state.blocked === true ? { blocked: true } : {}),
  };
}

export function noteSettlementDispatchAuthority(
  turnId: string | undefined,
  taskId: string,
  authority: SettlementDispatchAuthority | undefined,
): void {
  if (turnId === undefined || turnId.length === 0 || taskId.length === 0) return;
  try {
    slot.update((current) => {
      const state = readState(current);
      if (state.turn !== turnId) {
        return authority === undefined
          ? { turn: turnId, taskId, blocked: true }
          : { turn: turnId, taskId, authority };
      }
      if (state.blocked === true) return state;
      if (state.taskId !== taskId || state.authority === undefined || authority === undefined) {
        return { turn: turnId, blocked: true };
      }
      return JSON.stringify(state.authority) === JSON.stringify(authority)
        ? state
        : { turn: turnId, blocked: true };
    });
  } catch {
  }
}

export type SettlementDispatchResolution =
  | { readonly kind: "none" }
  | { readonly kind: "blocked" }
  | { readonly kind: "single"; readonly authority: SettlementDispatchAuthority };

export function settlementDispatchAuthorityThisTurn(turnId: string | undefined): SettlementDispatchResolution {
  if (turnId === undefined || turnId.length === 0) return { kind: "none" };
  try {
    const state = readState(slot.get());
    if (state.turn !== turnId) return { kind: "none" };
    if (state.blocked === true || state.authority === undefined) return { kind: "blocked" };
    return { kind: "single", authority: state.authority };
  } catch {
    return { kind: "blocked" };
  }
}
