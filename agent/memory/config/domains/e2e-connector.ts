import { defineDomain } from "@open-everywhere/core/agent/memory/domain.js";
import { UTILITY_MODEL } from "../../../model/models.js";

export const domain = defineDomain({
  name: "e2e-connector",
  reach: ["slack/T0EXAMPLE/C0EXGENRL"],
  credentialGrants: ["notion"],
  memory: "e2e-brain",
  ambientSupervisor: true,
  mode: "solo",
  engagementTier: "neutral",
  models: { primary: { id: UTILITY_MODEL } },
});
