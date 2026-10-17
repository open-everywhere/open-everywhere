import { defineDomain } from "@open-everywhere/core/agent/memory/domain.js";
import { UTILITY_MODEL } from "../../../model/models.js";

export const IT_OPT_OUT_SLACK_SURFACE = "slack/T0EXAMPLE/C0EXOPTOUT1";

export const domain = defineDomain({
  name: "it-opt-out",
  reach: [IT_OPT_OUT_SLACK_SURFACE],
  memory: "it-opt-out-brain",
  ambientSupervisor: true,
  mode: "solo",
  engagementTier: "neutral",
  models: { primary: { id: UTILITY_MODEL } },
});
