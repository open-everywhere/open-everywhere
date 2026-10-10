import { defineDomain } from "@open-everywhere/core/agent/memory/domain.js";
import { UTILITY_MODEL } from "../../../model/models.js";

export const domain = defineDomain({
  name: "e2e-cap",
  reach: ["slack/T0EXAMPLE/C0EXCHAN007"],
  memory: "e2e-brain",
  ambientSupervisor: false,
  engagementTier: "neutral",
  models: { primary: { id: UTILITY_MODEL } },
});
