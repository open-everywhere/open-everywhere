import { defineSpendBudgets, assertSpendBudgetsValid, type SpendBudgets } from "@open-everywhere/core/agent/spend/spend.js";

const budgets: SpendBudgets = defineSpendBudgets({
});

assertSpendBudgetsValid(budgets);

export function loadSpendBudgets(): SpendBudgets {
  return budgets;
}
