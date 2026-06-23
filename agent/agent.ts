import { defineAgent } from "eve";

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
});
