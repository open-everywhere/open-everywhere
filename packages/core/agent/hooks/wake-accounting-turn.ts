import { defineHook, type HookContext } from "eve/hooks";
import { defineState } from "eve/context";
import { deploymentOrg, currentTurnId, currentWakeId, type BindableContext } from "../identity/binding.js";
import { consumeReactedThisTurn } from "../channels/react-signal.js";
import { consumeNoReplyThisTurn } from "../channels/no-reply-signal.js";
import { auditLabels, auditUnaccountedWakesForTurn } from "../channels/unified.js";
import { bareTokenFromEveContext } from "../channels/window-key.js";
import { optional } from "./control-refusal.js";
import { interactionKindOf } from "./event-reads.js";

export function requestsHoldTheWorkerOpen(kinds: readonly (string | undefined)[]): boolean {
  if (kinds.length === 0) return true;
  return kinds.some((kind) => kind !== "budget");
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

async function runAccounting(ctx: HookContext): Promise<void> {
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
    "turn.started": optional("wake-accounting-turn", () => {
      markAccounted(undefined);
      consumeNoReplyThisTurn();
      consumeReactedThisTurn();
    }),
    "turn.paused": optional("wake-accounting-turn", async (event, ctx) => {
      const kinds = event.data.awaiting.map((a) => interactionKindOf(ctx.view, a.interactionId));
      if (!requestsHoldTheWorkerOpen(kinds)) await runAccounting(ctx);
    }),
    "turn.settled": optional("wake-accounting-turn", async (_event, ctx) => {
      await runAccounting(ctx);
    }),
    "session.ended": optional("wake-accounting-turn", async (event, ctx) => {
      if (event.data.outcome === "failed") await runAccounting(ctx);
    }),
  },
});
