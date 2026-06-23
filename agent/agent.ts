import { fireworks } from "@ai-sdk/fireworks";
import { defineAgent } from "eve";

const model = fireworks(
  process.env.FIREWORKS_MODEL ?? "accounts/fireworks/models/glm-5p2",
);

export default defineAgent({
  model,
});
