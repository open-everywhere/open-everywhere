import { defineHook } from "eve/hooks";
import { resetLoopBreakerTurn } from "../access/loop-breaker.js";
import { resetConnectorAuthMemo } from "../connections/auth-retry-memo.js";

export default defineHook({
  events: {
    "turn.started": async () => {
      resetLoopBreakerTurn();
      resetConnectorAuthMemo();
    },
  },
});
