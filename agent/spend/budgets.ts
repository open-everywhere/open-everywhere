import { defineSpendBudgets, assertSpendBudgetsValid, type SpendBudgets } from "@open-everywhere/core/agent/spend/spend.js";

const budgets: SpendBudgets = defineSpendBudgets({
  perDomain: {
    "e2e-connector": {
      surfaceMonthlyUsd: 50,
    },
    "e2e-unified": {
      surfaceMonthlyUsd: 50,
    },
  },
  perSurface: {
    "discord/1300000000000000100/1300000000000000101": {
      surfaceMonthlyUsd: 50,
      workspaceMonthlyUsd: 10,
    },
    "slack/T0EXAMPLE/C0EXCHAN007": {
      surfaceMonthlyUsd: 0.01,
      surfaceMonthlyTokens: 10_000,
    },
  },
  perWorkspace: {
    "discord/1300000000000000100": {
      workspaceMonthlyUsd: 10,
    },
  },
});

assertSpendBudgetsValid(budgets);

export function loadSpendBudgets(): SpendBudgets {
  return budgets;
}
