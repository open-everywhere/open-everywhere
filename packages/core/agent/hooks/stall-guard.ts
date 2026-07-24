import { defineHook } from "eve/hooks";
import { recordActionRequest, recordActionResult } from "../stall/guard.js";

export default defineHook({
  events: {
    "actions.requested": async (event) => {
      const turnId = event.data.turnId;
      for (const action of event.data.actions) {
        if (action.kind === "tool-call") recordActionRequest(turnId, action.callId, action.toolName, action.input);
      }
    },
    "action.result": async (event) => {
      const result = event.data.result;
      if (result.kind === "tool-result" && event.data.status !== "rejected") {
        recordActionResult(event.data.turnId, result.callId, result.toolName, result.output);
      }
    },
  },
});
