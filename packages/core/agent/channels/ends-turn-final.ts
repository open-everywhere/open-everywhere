import { defineState } from "eve/context";
import type { ContentCompleted, ContentCompletedData, Scope } from "eve/events";
import { pendingDelegationThisTurn } from "../access/pending-delegation-signal.js";
import { contentTextOf } from "./turn-delivery.js";

const decidedTurn = defineState<string | null>("open-everywhere.ends-turn-final.decided", () => null);

function markDecided(turnId: string | undefined): void {
  if (turnId === undefined || turnId.length === 0) return;
  try {
    decidedTurn.update(() => turnId);
  } catch {
  }
}

function wasDecided(turnId: string | undefined): boolean {
  if (turnId === undefined || turnId.length === 0) return false;
  try {
    return decidedTurn.get() === turnId;
  } catch {
    return false;
  }
}

export const ENDS_TURN_FINAL_MARK = "__oeEndsTurnFinal";

type AdapterFn = (event: unknown, adapterContext: unknown) => unknown;

interface EventShape {
  readonly type?: unknown;
  readonly scope?: { readonly turnId?: unknown };
  readonly data?: unknown;
}

function turnIdOf(event: EventShape, adapterContext: unknown): string | undefined {
  const scoped = event.scope?.turnId;
  if (typeof scoped === "string" && scoped.length > 0) return scoped;
  const dataTurn = (event.data as { readonly turnId?: unknown } | undefined)?.turnId;
  if (typeof dataTurn === "string" && dataTurn.length > 0) return dataTurn;
  const sessionTurn = (adapterContext as { readonly session?: { readonly turn?: { readonly id?: unknown } } } | undefined)?.session?.turn?.id;
  return typeof sessionTurn === "string" && sessionTurn.length > 0 ? sessionTurn : undefined;
}

export function syntheticEmptyReply(turnId: string, scope?: Scope): ContentCompleted {
  return {
    type: "content.completed",
    scope: { ...(scope ?? {}), turnId },
    data: { partId: "", kind: "text", phase: "reply", value: "" },
  };
}

export function withEndsTurnFinalChannel<C extends object>(channel: C): C {
  const adapter = (channel as { readonly adapter?: unknown }).adapter as Record<string, unknown> | undefined;
  if (adapter === undefined || adapter === null || typeof adapter !== "object") return channel;
  const onCompleted = adapter["content.completed"] as AdapterFn | undefined;
  if (typeof onCompleted !== "function") return channel;
  const onTurnSettled = adapter["turn.settled"] as AdapterFn | undefined;
  const wrapped: Record<string, unknown> = {
    ...adapter,
    [ENDS_TURN_FINAL_MARK]: true,
    "content.completed": async (event: unknown, adapterContext: unknown) => {
      const e = (event ?? {}) as EventShape;
      const text = contentTextOf((e.data ?? {}) as ContentCompletedData);
      if (text !== undefined && text.finishReason !== "tool-calls") {
        const turnId = turnIdOf(e, adapterContext);
        const preWait = text.message.length > 0 && pendingDelegationThisTurn(turnId) !== undefined;
        if (preWait) {
          console.log(
            `[open-everywhere:ends-turn-final] pre-wait text (${text.message.length} chars) while worker task ${pendingDelegationThisTurn(turnId)} is pending — not passed to the channel`,
          );
          return undefined;
        }
        markDecided(turnId);
      }
      return await onCompleted(event, adapterContext);
    },
    "turn.settled": async (event: unknown, adapterContext: unknown) => {
      if (typeof onTurnSettled === "function") {
        try {
          await onTurnSettled(event, adapterContext);
        } catch (err) {
          console.warn(`[open-everywhere:ends-turn-final] the channel's own turn.settled threw — deciding the turn anyway: ${String(err)}`);
        }
      }
      const e = (event ?? {}) as EventShape & { readonly data?: { readonly outcome?: unknown } };
      if (e.data?.outcome !== "completed") return;
      const turnId = turnIdOf(e, adapterContext);
      if (turnId === undefined || wasDecided(turnId)) return;
      markDecided(turnId);
      await onCompleted(syntheticEmptyReply(turnId, e.scope as Scope | undefined), adapterContext);
    },
  };
  return { ...channel, adapter: wrapped } as C;
}
