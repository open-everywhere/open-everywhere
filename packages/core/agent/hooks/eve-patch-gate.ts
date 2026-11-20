import { defineHook } from "eve/hooks";
import { evePatchTurnRefusal } from "../access/eve-patch-probe.js";
import { refuseTurn, type RefusableContext } from "./control-refusal.js";

export default defineHook({
  events: {
    // hook-path: REFUSAL — a missing patch marker cancels the turn before it runs unfenced
    "turn.started": async (_event, ctx) => {
      const refusal = evePatchTurnRefusal();
      if (refusal === undefined) return;
      await refuseTurn(ctx as RefusableContext, {
        hook: "eve-patch-gate",
        phase: "turn.started",
        reason: "eve-unpatched",
        message: refusal,
      });
    },
  },
});
