import { assertModelAbTestValid, modelAbTestArmed, type ModelAbTest } from "@open-everywhere/core/agent/model/ab-test.js";
import { PRIMARY_MODEL } from "./models.js";
import { STACKS, type StackAlias } from "./stacks.js";

export const CHALLENGER_STACK: StackAlias = "chinese-open-weights";

export const MODEL_AB_TEST: ModelAbTest = {
  challenger: STACKS[CHALLENGER_STACK].primary.id,
  percent: 0,
};

assertModelAbTestValid(MODEL_AB_TEST);

export function abTestCollidesWithChampion(test: ModelAbTest, championId: string): boolean {
  return modelAbTestArmed(test) && test.challenger === championId;
}

if (abTestCollidesWithChampion(MODEL_AB_TEST, PRIMARY_MODEL)) {
  throw new Error(
    `model A/B test: the challenger "${MODEL_AB_TEST.challenger}" IS this deployment's resolved champion, so both ` +
      `arms would run one model. Point CHALLENGER_STACK at a different stack, or set percent to 0. ` +
      `(The champion follows models.stack in agent/settings/settings.ts, which \`npm run e2e:stack\` also moves.)`,
  );
}

export function loadModelAbTest(): ModelAbTest | undefined {
  return MODEL_AB_TEST;
}
