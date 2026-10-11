import { defineDomain } from "@open-everywhere/core/agent/memory/domain.js";
import { UTILITY_MODEL } from "../../../model/models.js";

export const domain = defineDomain({
  name: "it-notion-withhold",
  reach: [
    "notion/6f7ea678-0000-4000-8000-000000000001/6f7ea678-0000-4000-8000-000000000002",
    "notion/6f7ea678-0000-4000-8000-000000000001/6f7ea678-0000-4000-8000-000000000003",
    "discord/1300000000000000100/1300000001500000004",
  ],
  reportChannel: "discord/1300000000000000100/1300000001500000004",
  mode: "solo",
  ambientSupervisor: true,
  engagementTier: "neutral",
  models: { primary: { id: UTILITY_MODEL } },
});
