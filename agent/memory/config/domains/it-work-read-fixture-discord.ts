import { defineDomain } from "@open-everywhere/core/agent/memory/domain.js";
import { UTILITY_MODEL } from "../../../model/models.js";

export const domain = defineDomain({
  name: "it-work-read-fixture-discord",
  reach: ["discord/1300000000000000100/1300000001500000009"],
  ambientSupervisor: true,
  mode: "solo",
  engagementTier: "neutral",
  models: { primary: { id: UTILITY_MODEL } },
  credentials: [{ connector: "discord", credential: "work-token", use: "chat-token" }],
});
