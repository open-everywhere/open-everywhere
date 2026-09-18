import { defineDomain } from "@open-everywhere/core/agent/memory/domain.js";
import { UTILITY_MODEL } from "../../../model/models.js";

export const domain = defineDomain({
  name: "it-judge-lift-github",
  reach: ["github/oe-it-judge-lift/arm-a", "github/oe-it-judge-lift/arm-b", "discord/1300000000000000100/1300000001500000006"],
  reportChannel: "discord/1300000000000000100/1300000001500000006",
  ambientSupervisor: true,
  engagementTier: "neutral",
  models: { primary: { id: UTILITY_MODEL } },
});
