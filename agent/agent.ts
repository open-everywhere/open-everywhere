import { defineAgent } from "eve";
import "./lib/register-config.js";
import "./lib/register-adapters.js";

export default defineAgent({
  model: "zai/glm-5.2",
  reasoning: "medium",
  modelOptions: {
    providerOptions: {
      gateway: {
        only: ["fireworks"],
        zeroDataRetention: true,
        caching: "auto",
      },
    },
  },
});
