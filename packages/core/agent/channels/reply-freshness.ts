import { defineState } from "eve/context";
import { currentWakeId, currentTurnAddressing, type BindableContext } from "../identity/binding.js";

interface FreshnessState {
  readonly turnId: string;
  readonly answeredWakeId: string | undefined;
  readonly nudgedWakeId: string | undefined;
  readonly newerSeen: number;
}

const slot = defineState<FreshnessState | null>("open-everywhere.reply-freshness", () => null);

export type FreshnessGrade =
  | { readonly kind: "fresh" }
  | { readonly kind: "notice"; readonly newerCount: number }
  | { readonly kind: "refuse"; readonly newerCount: number };

function turnIdOf(ctx: BindableContext): string | undefined {
  const turn = (ctx as { session?: { turn?: { id?: string } } }).session?.turn;
  return typeof turn?.id === "string" && turn.id.length > 0 ? turn.id : undefined;
}

function freshState(turnId: string): FreshnessState {
  return { turnId, answeredWakeId: undefined, nudgedWakeId: undefined, newerSeen: 0 };
}

export function gradeReplyFreshness(ctx: BindableContext, force: boolean): FreshnessGrade {
  const turnId = turnIdOf(ctx);
  const wakeId = currentWakeId(ctx);
  if (turnId === undefined || wakeId === undefined) return { kind: "fresh" };

  let state: FreshnessState;
  try {
    const prev = slot.get();
    state = prev && prev.turnId === turnId ? prev : freshState(turnId);
  } catch {
    return { kind: "fresh" };
  }

  if (state.answeredWakeId === undefined || state.answeredWakeId === wakeId) {
    persist({ turnId, answeredWakeId: wakeId, nudgedWakeId: undefined, newerSeen: state.newerSeen });
    return { kind: "fresh" };
  }

  const newerCount = state.newerSeen + 1;
  const direct = currentTurnAddressing(ctx) === "direct-mention";
  const alreadyNudged = state.nudgedWakeId === wakeId;
  if (direct && !force && !alreadyNudged) {
    persist({ ...state, nudgedWakeId: wakeId });
    return { kind: "refuse", newerCount };
  }
  persist({ turnId, answeredWakeId: wakeId, nudgedWakeId: undefined, newerSeen: newerCount });
  return { kind: "notice", newerCount };

  function persist(next: FreshnessState): void {
    try {
      slot.update(() => next);
    } catch {
    }
  }
}

export function freshnessRefusalMessage(newerCount: number): string {
  return (
    `reply: NOT sent — at least ${newerCount} newer, directly-addressed message${newerCount === 1 ? " has" : "s have"} ` +
    `arrived in this conversation since your last post; this turn has moved on. Re-read the conversation ` +
    `(the new content is already in your context) before replying again — your next attempt will go ` +
    `through. Pass force:true now only if sending this exact reply immediately matters more than ` +
    `reflecting the newer message.`
  );
}

export function freshnessNoticeText(newerCount: number, forced: boolean): string {
  const base = `${newerCount} newer message${newerCount === 1 ? "" : "s"} arrived in this conversation since your last post.`;
  return forced ? `${base} Posted anyway (force:true).` : `${base} Posted — consider reading them next.`;
}
