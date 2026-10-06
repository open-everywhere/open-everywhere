import { defineHook, type HookContext } from "eve/hooks";
import { defineState } from "eve/context";
import { deploymentOrg, currentTurnId, currentWakeId, type BindableContext } from "../identity/binding.js";
import { consumeReactedThisTurn } from "../channels/react-signal.js";
import { consumeNoReplyThisTurn } from "../channels/no-reply-signal.js";
import { auditLabels, auditUnaccountedWakesForTurn } from "../channels/unified.js";
import { bareTokenFromEveContext } from "../channels/window-key.js";
import { isSessionLimitContinuationRequest } from "../channels/session-park.js";

export function requestsHoldTheWorkerOpen(requests: unknown): boolean {
  if (!Array.isArray(requests) || requests.length === 0) return true;
  return requests.some((r) => !isSessionLimitContinuationRequest(r));
}

const paused = defineState<{ awaiting: boolean }>("open-everywhere.wake-accounting.paused", () => ({ awaiting: false }));

function markPaused(): void {
  try {
    paused.update(() => ({ awaiting: true }));
  } catch {
  }
}

function clearPaused(): void {
  try {
    paused.update(() => ({ awaiting: false }));
  } catch {
  }
}

const accountedTurn = defineState<{ turnId: string | undefined }>("open-everywhere.wake-accounting.accounted-turn", () => ({ turnId: undefined }));

const NO_TURN_ID = "<none>";

function alreadyAccounted(turnKey: string): boolean {
  try {
    return accountedTurn.get().turnId === turnKey;
  } catch {
    return false;
  }
}

function markAccounted(turnKey: string | undefined): void {
  try {
    accountedTurn.update(() => ({ turnId: turnKey }));
  } catch {
  }
}

function turnStillPaused(): boolean {
  try {
    return paused.get().awaiting;
  } catch {
    return true;
  }
}

async function runAccounting(ctx: HookContext): Promise<void> {
  if (turnStillPaused()) return;
  const bind = { session: ctx.session } as unknown as BindableContext;
  const turnKey = currentTurnId(bind) ?? NO_TURN_ID;
  if (alreadyAccounted(turnKey)) return;
  markAccounted(turnKey);
  try {
    const org = deploymentOrg();
    const { workspace, surface } = auditLabels(ctx.channel.continuationToken);
    const reacted = consumeReactedThisTurn();
    await auditUnaccountedWakesForTurn(
      org,
      workspace,
      surface,
      bareTokenFromEveContext(ctx.channel.continuationToken),
      currentTurnId(bind),
      currentWakeId(bind),
      reacted,
    );
  } catch {
  }
}

export default defineHook({
  events: {
    "turn.started": () => {
      clearPaused();
      markAccounted(undefined);
      consumeNoReplyThisTurn();
      consumeReactedThisTurn();
    },
    "input.requested": (event) => {
      if (requestsHoldTheWorkerOpen((event.data as { requests?: unknown } | undefined)?.requests)) markPaused();
    },
    "authorization.required": () => {
      markPaused();
    },
    "turn.completed": async (_event, ctx) => {
      await runAccounting(ctx);
    },
    "turn.cancelled": async (_event, ctx) => {
      await runAccounting(ctx);
    },
    "turn.failed": async (_event, ctx) => {
      await runAccounting(ctx);
    },
    "session.failed": async (_event, ctx) => {
      await runAccounting(ctx);
    },
  },
});
