import { defineAgent } from "eve";

export default defineAgent({
  model: "zai/glm-5.2",
  modelOptions: {
    gateway: {
      only: ["fireworks"],
      order: ["fireworks"],
    },
  },
});
