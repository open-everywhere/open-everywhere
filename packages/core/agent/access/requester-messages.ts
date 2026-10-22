import { defineState } from "eve/context";
import { currentContinuationTurn } from "./continuation-turn-state.js";

interface RequesterMessagesState {
  readonly turn?: string;
  readonly messages: readonly string[];
}

const slot = defineState<RequesterMessagesState>("open-everywhere.requester-messages", () => ({ messages: [] }));

const MAX_MESSAGES = 6;
const MAX_MESSAGE_CHARS = 2000;

function readState(v: unknown): RequesterMessagesState {
  if (typeof v === "object" && v !== null && Array.isArray((v as { messages?: unknown }).messages)) {
    const s = v as { turn?: unknown; messages: unknown[] };
    return {
      turn: typeof s.turn === "string" ? s.turn : undefined,
      messages: s.messages.filter((m): m is string => typeof m === "string"),
    };
  }
  return { messages: [] };
}

export function recordRequesterMessage(turnId: string | undefined, text: string): void {
  const clipped = clipMessage(text);
  if (clipped.trim().length === 0) return;
  try {
    slot.update((cur) => {
      const state = readState(cur);
      const sameTurn = turnId !== undefined && state.turn === turnId;
      const messages = [...(sameTurn ? state.messages : []), clipped].slice(-MAX_MESSAGES);
      return { ...(turnId !== undefined ? { turn: turnId } : {}), messages };
    });
  } catch {
  }
}

export function requesterMessagesThisTurn(): readonly string[] {
  return requesterMessagesByTurn().current;
}

export function requesterMessagesByTurn(): { readonly current: readonly string[]; readonly earlier: readonly string[] } {
  let state: RequesterMessagesState;
  try {
    state = readState(slot.get());
  } catch {
    return { current: [], earlier: [] };
  }
  const now = currentContinuationTurn()?.turnId;
  const isCurrent = state.turn !== undefined && now !== undefined && state.turn === now;
  return isCurrent ? { current: state.messages, earlier: [] } : { current: [], earlier: state.messages };
}

export interface RequesterAsk {
  readonly wakeId: string;
  readonly authorId: string;
  readonly body: string;
}

interface RequesterAsksState {
  readonly turn?: string;
  readonly asks: readonly RequesterAsk[];
}

const asksSlot = defineState<RequesterAsksState>("open-everywhere.requester-asks", () => ({ asks: [] }));

function readAsksState(v: unknown): RequesterAsksState {
  if (typeof v !== "object" || v === null || !Array.isArray((v as { asks?: unknown }).asks)) return { asks: [] };
  const s = v as { turn?: unknown; asks: unknown[] };
  const asks = s.asks.filter(
    (a): a is RequesterAsk =>
      typeof a === "object" &&
      a !== null &&
      typeof (a as RequesterAsk).wakeId === "string" &&
      typeof (a as RequesterAsk).authorId === "string" &&
      typeof (a as RequesterAsk).body === "string",
  );
  return { ...(typeof s.turn === "string" ? { turn: s.turn } : {}), asks };
}

function clipMessage(text: string): string {
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…[truncated]` : text;
}

export function recordRequesterAsk(turnId: string | undefined, ask: RequesterAsk): void {
  if (turnId === undefined || turnId.length === 0) return;
  if (ask.wakeId.length === 0 || ask.authorId.length === 0 || ask.body.trim().length === 0) return;
  const clipped: RequesterAsk = { wakeId: ask.wakeId, authorId: ask.authorId, body: clipMessage(ask.body) };
  try {
    asksSlot.update((cur) => {
      const state = readAsksState(cur);
      const prior = state.turn === turnId ? state.asks : [];
      if (prior.some((a) => a.wakeId === clipped.wakeId && a.authorId === clipped.authorId && a.body === clipped.body)) return { turn: turnId, asks: prior };
      const asks = [...prior, clipped].slice(-MAX_MESSAGES);
      return { turn: turnId, asks };
    });
  } catch {
  }
}

export function requesterAsksForWake(input: { readonly turnId: string | undefined; readonly wakeId: string; readonly principalId: string }): readonly string[] {
  if (input.turnId === undefined || input.turnId.length === 0) return [];
  let state: RequesterAsksState;
  try {
    state = readAsksState(asksSlot.get());
  } catch {
    return [];
  }
  if (state.turn !== input.turnId) return [];
  return state.asks.filter((a) => a.wakeId === input.wakeId && a.authorId === input.principalId).map((a) => a.body);
}

export function requesterAsksThisTurn(turnId: string | undefined): readonly RequesterAsk[] {
  if (turnId === undefined || turnId.length === 0) return [];
  let state: RequesterAsksState;
  try {
    state = readAsksState(asksSlot.get());
  } catch {
    return [];
  }
  return state.turn === turnId ? state.asks : [];
}
