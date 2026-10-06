import { defineState } from "eve/context";
import { pendingDelegationThisTurn } from "../access/pending-delegation-signal.js";

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

interface CompletedData {
  readonly finishReason?: unknown;
  readonly turnId?: unknown;
}

interface TurnCompletedData {
  readonly turnId?: unknown;
  readonly sequence?: unknown;
}

export const ENDS_TURN_FINAL_MARK = "__oeEndsTurnFinal";

type AdapterFn = (data: unknown, adapterContext: unknown) => unknown;

function turnIdOf(data: { readonly turnId?: unknown }): string | undefined {
  return typeof data.turnId === "string" && data.turnId.length > 0 ? data.turnId : undefined;
}

export function withEndsTurnFinalChannel<C extends object>(channel: C): C {
  const adapter = (channel as { readonly adapter?: unknown }).adapter as Record<string, unknown> | undefined;
  if (adapter === undefined || adapter === null || typeof adapter !== "object") return channel;
  const onCompleted = adapter["message.completed"] as AdapterFn | undefined;
  if (typeof onCompleted !== "function") return channel;
  const onTurnCompleted = adapter["turn.completed"] as AdapterFn | undefined;
  const wrapped: Record<string, unknown> = {
    ...adapter,
    [ENDS_TURN_FINAL_MARK]: true,
    "message.completed": async (data: unknown, adapterContext: unknown) => {
      const d = (data ?? {}) as CompletedData & { readonly message?: unknown };
      if (d.finishReason !== "tool-calls") {
        const turnId = turnIdOf(d);
        const preWait = d.finishReason === "stop" && typeof d.message === "string" && d.message.length > 0 && pendingDelegationThisTurn(turnId) !== undefined;
        if (preWait) {
          console.log(
            `[open-everywhere:ends-turn-final] pre-wait text (${(d.message as string).length} chars) while worker task ${pendingDelegationThisTurn(turnId)} is pending — not passed to the channel`,
          );
          return undefined;
        }
        markDecided(turnId);
      }
      return await onCompleted(data, adapterContext);
    },
    "turn.completed": async (data: unknown, adapterContext: unknown) => {
      if (typeof onTurnCompleted === "function") {
        try {
          await onTurnCompleted(data, adapterContext);
        } catch (err) {
          console.warn(`[open-everywhere:ends-turn-final] the channel's own turn.completed threw — deciding the turn anyway: ${String(err)}`);
        }
      }
      const d = (data ?? {}) as TurnCompletedData;
      const turnId = turnIdOf(d);
      if (turnId === undefined || wasDecided(turnId)) return;
      markDecided(turnId);
      await onCompleted({ finishReason: "stop", message: "", sequence: typeof d.sequence === "number" ? d.sequence : 0, stepIndex: 0, turnId }, adapterContext);
    },
  };
  return { ...channel, adapter: wrapped } as C;
}
