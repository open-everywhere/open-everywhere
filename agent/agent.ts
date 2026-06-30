import { defineAgent } from "eve";
import "./lib/register-config.js";
import "./lib/register-adapters.js";

export default defineAgent({
  model: "zai/glm-5.2",
  modelOptions: {
    providerOptions: {
      gateway: {
        only: ["fireworks"],
        zeroDataRetention: true,
        caching: "auto",
      },
    },
  },
  experimental: { codeMode: true },
});
