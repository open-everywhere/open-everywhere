import { defineHook, type HookContext } from "eve/hooks";
import { defineState } from "eve/context";
import { deploymentOrg, currentTurnId, currentWakeId, type BindableContext } from "../identity/binding.js";
import { consumeReactedThisTurn } from "../channels/react-signal.js";
import { auditLabels, auditUnaccountedWakesForTurn } from "../channels/unified.js";
import { bareTokenFromEveContext } from "../channels/window-key.js";
import { requestsHoldTheWorkerOpen } from "./oneshot-complete.js";

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

function turnStillPaused(): boolean {
  try {
    return paused.get().awaiting;
  } catch {
    return true;
  }
}

async function runAccounting(ctx: HookContext): Promise<void> {
  if (turnStillPaused()) return;
  try {
    const bind = { session: ctx.session } as unknown as BindableContext;
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
    "session.failed": async (_event, ctx) => {
      await runAccounting(ctx);
    },
  },
});
