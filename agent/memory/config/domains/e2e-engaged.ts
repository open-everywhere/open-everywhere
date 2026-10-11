import { defineDomain } from "@open-everywhere/core/agent/memory/domain.js";
import { UTILITY_MODEL } from "../../../model/models.js";

export const domain = defineDomain({
  name: "e2e-engaged",
  reach: [
    "linear/1a000000-0000-4000-8000-000000000002/1a000000-0000-4000-8000-000000000012",
    "notion/40000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000104",
    "discord/1300000000000000100/1300000000000000102",
    "github/example-owner/oe-e2e-addressed-github",
  ],
  memory: "e2e-brain",
  ambientSupervisor: false,
  mode: "solo",
  nameDropWake: true,
  engagementTier: "neutral",
  models: { primary: { id: UTILITY_MODEL } },
});
