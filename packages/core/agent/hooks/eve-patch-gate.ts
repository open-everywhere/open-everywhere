import { defineHook } from "eve/hooks";
import { assertEvePatchedAtTurn } from "../access/eve-patch-probe.js";

export default defineHook({
  events: {
    "turn.started": (_event, _ctx) => {
      assertEvePatchedAtTurn();
    },
  },
});
