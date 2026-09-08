import { defineDomain } from "@open-everywhere/core/agent/memory/domain.js";
import { UTILITY_MODEL } from "../../../model/models.js";

export const domain = defineDomain({
  name: "it-work-read-fixture-notion",
  reach: ["notion/6f7ea678-1071-4000-8000-000000000001/6f7ea678-1071-4000-8000-000000000002"],
  ambientSupervisor: true,
  engagementTier: "neutral",
  models: { primary: { id: UTILITY_MODEL } },
  credentialGrants: ["notion"],
  credentials: [{ connector: "notion", credential: "team-key", use: "channel-key" }],
});
