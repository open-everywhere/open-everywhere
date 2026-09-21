import { defineState } from "eve/context";

export type AccessRequestOutcome = "card-posted" | "auto-approved" | "already-pending";

export interface AccessRequestProposal {
  readonly kind: string;
  readonly outcome: AccessRequestOutcome;
}

interface LedgerState {
  readonly turn?: string;
  readonly proposals?: readonly AccessRequestProposal[];
}

const slot = defineState<LedgerState>("open-everywhere.access-request-ledger", () => ({}));

const MAX_PROPOSALS = 8;

export const ACCESS_REQUEST_KIND = "access.request";

function readProposal(v: unknown): AccessRequestProposal[] {
  if (typeof v !== "object" || v === null) return [];
  const raw = v as { kind?: unknown; outcome?: unknown };
  if (typeof raw.kind !== "string" || raw.kind.length === 0) return [];
  if (raw.outcome !== "card-posted" && raw.outcome !== "auto-approved" && raw.outcome !== "already-pending") return [];
  return [{ kind: raw.kind, outcome: raw.outcome }];
}

function readState(v: unknown): LedgerState {
  if (typeof v !== "object" || v === null) return {};
  const s = v as { turn?: unknown; proposals?: unknown };
  const turn = typeof s.turn === "string" && s.turn.length > 0 ? s.turn : undefined;
  const proposals = turn === undefined || !Array.isArray(s.proposals) ? [] : s.proposals.flatMap(readProposal);
  return { ...(turn === undefined ? {} : { turn }), proposals };
}

export function noteAccessRequestProposed(turnId: string | undefined, kind: string, outcome: AccessRequestOutcome): void {
  const turn = turnId ?? "";
  if (turn.length === 0) return;
  try {
    slot.update((cur) => {
      const state = readState(cur);
      const proposals = state.turn === turn ? (state.proposals ?? []) : [];
      if (proposals.length >= MAX_PROPOSALS) return { turn, proposals };
      return { turn, proposals: [...proposals, { kind, outcome }] };
    });
  } catch {
  }
}

export function accessRequestsProposedThisTurn(turnId: string | undefined): readonly AccessRequestProposal[] {
  if (turnId === undefined || turnId.length === 0) return [];
  let state: LedgerState;
  try {
    state = readState(slot.get());
  } catch {
    return [];
  }
  if (state.turn !== turnId) return [];
  return state.proposals ?? [];
}
