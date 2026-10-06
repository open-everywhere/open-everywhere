import { defineDomain } from "@open-everywhere/core/agent/memory/domain.js";
import { UTILITY_MODEL } from "../../../model/models.js";

export const domain = defineDomain({
  name: "it-work-memory",
  reach: ["discord/1300000000000000100/1300000001500000013"],
  memory: "it-work-memory-brain",
  ambientSupervisor: true,
  mode: "solo",
  engagementTier: "neutral",
  models: { primary: { id: UTILITY_MODEL } },
});
