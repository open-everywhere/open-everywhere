import { defineState } from "eve/context";
import { currentTurnId, deploymentOrg, subagentParentSessionId, type BindableContext } from "../identity/binding.js";
import { delegatedRequesterThisTurn } from "../identity/delegated-binding.js";
import { parseWindowToken } from "../channels/window-key.js";
import { readWorkCall, readWorkRequest, workTokenForSeat, type WorkRequestRow } from "../channels/work.js";
import { ensureDelegatedTaskBinding } from "../channels/task-wake.js";
import { readContinuationWake } from "../channels/task-provenance.js";
import { getOperationalStore } from "../operational/provider.js";
import { resolveOwnWindowToken } from "./delegation-mount.js";
import { isWorkSessionChildContext } from "./work-session.js";
import { recordRequesterMessage } from "./requester-messages.js";
import type { RequesterVerdict } from "./requester-identity.js";

const MAX_FORWARDED_ASKS = 6;

function sameWindow(a: string | undefined, b: string | undefined): boolean {
  const ka = parseWindowToken(a?.startsWith("unified:") ? a.slice("unified:".length) : a);
  const kb = parseWindowToken(b?.startsWith("unified:") ? b.slice("unified:".length) : b);
  return ka !== undefined && kb !== undefined && ka.domain === kb.domain && ka.windowId === kb.windowId;
}

export type ForwardedAskRefusal =
  | "no-row"
  | "row-names-another-request"
  | "fire"
  | "row-requester-unverified"
  | "child-requester-differs"
  | "other-work-session"
  | "no-asks";

export function forwardedAsksFromRow(input: {
  readonly requestId: string | undefined;
  readonly row: WorkRequestRow | undefined;
  readonly childWorkToken: string | undefined;
  readonly childRequester: RequesterVerdict | undefined;
}): { readonly asks: readonly string[] } | { readonly refused: ForwardedAskRefusal } {
  const { row } = input;
  if (input.requestId === undefined || row === undefined) return { refused: "no-row" };
  if (row.requestId !== input.requestId) return { refused: "row-names-another-request" };
  if (row.fire !== undefined) return { refused: "fire" };
  if (row.requester.kind !== "requester") return { refused: "row-requester-unverified" };
  if (input.childRequester?.kind !== "requester" || input.childRequester.principalId !== row.requester.principalId) {
    return { refused: "child-requester-differs" };
  }
  if (!sameWindow(workTokenForSeat(row.seatToken), input.childWorkToken)) return { refused: "other-work-session" };
  const asks = (row.requesterAsks ?? []).filter((a) => typeof a === "string" && a.trim().length > 0).slice(-MAX_FORWARDED_ASKS);
  if (asks.length === 0) return { refused: "no-asks" };
  return { asks };
}

export interface ForwardedAskDeps {
  readonly org: () => string;
  readonly ensureBinding: (ctx: BindableContext) => Promise<void>;
  readonly readCall: (org: string, workSessionId: string, callId: string) => Promise<string | undefined>;
  readonly readRequest: (org: string, requestId: string) => Promise<WorkRequestRow | undefined>;
  readonly readContinuation: (org: string, workSessionId: string, openingCallId: string) => Promise<string | undefined>;
  readonly delegatedRequester: () => RequesterVerdict | undefined;
  readonly record: (turnId: string, text: string) => void;
  readonly lastAdoption: () => ForwardedAskAdoptionMark | undefined;
  readonly noteAdoption: (mark: ForwardedAskAdoptionMark) => void;
}

export interface ForwardedAskAdoptionMark {
  readonly turnId: string;
  readonly requestId: string;
}

const adoptionSlot = defineState<ForwardedAskAdoptionMark | null>("open-everywhere.forwarded-asks.adopted", () => null);

function readAdoptionMark(): ForwardedAskAdoptionMark | undefined {
  try {
    const v = adoptionSlot.get() as unknown;
    if (typeof v !== "object" || v === null) return undefined;
    const m = v as { turnId?: unknown; requestId?: unknown };
    return typeof m.turnId === "string" && typeof m.requestId === "string" ? { turnId: m.turnId, requestId: m.requestId } : undefined;
  } catch {
    return undefined;
  }
}

function writeAdoptionMark(mark: ForwardedAskAdoptionMark): void {
  try {
    adoptionSlot.update(() => mark);
  } catch {
  }
}

const LIVE_DEPS: ForwardedAskDeps = {
  org: deploymentOrg,
  ensureBinding: ensureDelegatedTaskBinding,
  readCall: (org, workSessionId, callId) => readWorkCall(getOperationalStore(), org, workSessionId, callId),
  readRequest: (org, requestId) => readWorkRequest(getOperationalStore(), org, requestId).catch(() => undefined),
  readContinuation: readContinuationWake,
  delegatedRequester: () => delegatedRequesterThisTurn(undefined),
  record: recordRequesterMessage,
  lastAdoption: readAdoptionMark,
  noteAdoption: writeAdoptionMark,
};

export type ForwardedAskAdoption =
  | { readonly adopted: number }
  | { readonly refused: ForwardedAskRefusal | "not-a-work-child" | "no-turn" | "no-linkage" | "binding-unavailable" | "already-adopted-this-turn" | "request-already-adopted" };

export async function adoptForwardedRequesterAsks(ctx: BindableContext, deps: ForwardedAskDeps = LIVE_DEPS): Promise<ForwardedAskAdoption> {
  try {
    if (!isWorkSessionChildContext(ctx)) return { refused: "not-a-work-child" };
    const turnId = currentTurnId(ctx);
    if (turnId === undefined) return { refused: "no-turn" };
    const workSessionId = subagentParentSessionId(ctx);
    const callId = (ctx as { session?: { parent?: { callId?: unknown } } }).session?.parent?.callId;
    if (workSessionId === undefined || typeof callId !== "string" || callId.length === 0) return { refused: "no-linkage" };
    const last = deps.lastAdoption();
    if (last?.turnId === turnId) return { refused: "already-adopted-this-turn" };
    try {
      await deps.ensureBinding(ctx);
    } catch {
      return { refused: "binding-unavailable" };
    }
    const sequence = (ctx as { session?: { turn?: { sequence?: unknown } } }).session?.turn?.sequence;
    const laterTurn = typeof sequence === "number" && sequence > 0;
    const org = deps.org();
    const requestId = laterTurn ? await deps.readContinuation(org, workSessionId, callId) : await deps.readCall(org, workSessionId, callId);
    if (laterTurn && requestId !== undefined && last?.requestId === requestId) return { refused: "request-already-adopted" };
    const row = requestId === undefined ? undefined : await deps.readRequest(org, requestId);
    const verdict = forwardedAsksFromRow({ requestId, row, childWorkToken: resolveOwnWindowToken(ctx), childRequester: deps.delegatedRequester() });
    if ("refused" in verdict) return verdict;
    for (const ask of verdict.asks) deps.record(turnId, ask);
    deps.noteAdoption({ turnId, requestId: requestId as string });
    return { adopted: verdict.asks.length };
  } catch {
    return { refused: "no-linkage" };
  }
}
