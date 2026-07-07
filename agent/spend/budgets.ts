import { defineSpendBudgets, assertSpendBudgetsValid, type SpendBudgets } from "@open-everywhere/core/agent/spend/spend.js";

const budgets: SpendBudgets = defineSpendBudgets({
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
