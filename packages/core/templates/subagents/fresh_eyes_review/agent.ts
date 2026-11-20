import { defineAgent } from "eve";
import root from "../../agent.js";

export default defineAgent({
  description:
    "Independent second-pass review of a proposed change. Pass the full diff or file contents in `message` — it sees nothing else, no repo and no parent history. Returns a typed verdict: findings with severity plus approve/block.",
  model: root.model,
});
