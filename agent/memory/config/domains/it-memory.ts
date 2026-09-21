import { defineDomain } from "@open-everywhere/core/agent/memory/domain.js";
import { UTILITY_MODEL } from "../../../model/models.js";

export const domain = defineDomain({
  name: "it-memory",
  reach: [
    "discord/1300000000000000100/1300000001500000001",
    "discord/1300000000000000100/1300000001500000003",
    "discord/1300000000000000100/1300000001500000005",
    "discord/1300000000000000100/1300000001500000007",
    "discord/1300000000000000100/1300000001500000011",
  ],
  memory: "it-memory-brain",
  ambientSupervisor: true,
  mode: "solo",
  engagementTier: "neutral",
  models: { primary: { id: UTILITY_MODEL } },
});
