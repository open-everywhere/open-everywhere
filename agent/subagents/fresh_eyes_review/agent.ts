import { defineAgent } from "eve";
import { PRIMARY_MODEL } from "../../model/models.js";
import { FRESH_EYES_REVIEW_OUTPUT, modelFacingOutputSchema } from "@open-everywhere/core/agent/subagents/contracts.js";

export default defineAgent({
  description:
    "Independent second-pass review of a proposed change. Pass the full diff or file contents in `message` — it sees nothing else, no repo and no parent history. Returns a typed verdict: findings with severity plus approve/block.",
  model: PRIMARY_MODEL,
  outputSchema: modelFacingOutputSchema(FRESH_EYES_REVIEW_OUTPUT),
});
