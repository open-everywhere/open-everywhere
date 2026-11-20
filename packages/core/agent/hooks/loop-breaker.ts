import { defineHook } from "eve/hooks";
import { resetLoopBreakerTurn } from "../access/loop-breaker.js";
import { resetConnectorAuthMemo } from "../connections/auth-retry-memo.js";
import { resetSeatReadBudget } from "../access/seat-read-budget.js";
import { optional } from "./control-refusal.js";

export default defineHook({
  events: {
    "turn.started": optional("loop-breaker", () => {
      resetLoopBreakerTurn();
      resetConnectorAuthMemo();
      resetSeatReadBudget();
    }),
  },
});
