import { defineSpendCheckpoints, assertSpendCheckpointsValid, type SpendCheckpoints } from "@open-everywhere/core/agent/spend/checkpoint.js";

const checkpoints: SpendCheckpoints = defineSpendCheckpoints({
});

assertSpendCheckpointsValid(checkpoints);

export function loadSpendCheckpoints(): SpendCheckpoints {
  return checkpoints;
}
