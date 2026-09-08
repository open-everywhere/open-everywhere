import { defineDomain } from "@open-everywhere/core/agent/memory/domain.js";
import { UTILITY_MODEL } from "../../../model/models.js";

export const domain = defineDomain({
  name: "it-memory-b",
  reach: ["discord/1300000000000000100/1300000001500000002"],
  memory: "it-memory-b-brain",
  ambientSupervisor: true,
  mode: "solo",
  engagementTier: "neutral",
  models: { primary: { id: UTILITY_MODEL } },
});
