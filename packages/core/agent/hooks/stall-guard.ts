import { defineHook } from "eve/hooks";
import { call } from "eve/events";
import { recordActionRequest, recordActionResult } from "../stall/guard.js";
import { optional } from "./control-refusal.js";

export default defineHook({
  events: {
    "call.requested": optional("stall-guard", (event, ctx) => {
      if (event.data.capability.kind !== "tool") return;
      const turnId = event.scope?.turnId ?? call(ctx.view, event.data.callId)?.turnId;
      recordActionRequest(turnId ?? null, event.data.callId, event.data.capability.name, event.data.input);
    }),
    "call.settled": optional("stall-guard", (event, ctx) => {
      if (event.data.outcome === "rejected") return;
      const observed = call(ctx.view, event.data.callId);
      if (observed === undefined || observed.kind !== "tool") return;
      recordActionResult(observed.turnId ?? event.scope?.turnId ?? null, event.data.callId, observed.name, event.data.output);
    }),
  },
});
