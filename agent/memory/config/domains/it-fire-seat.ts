import { defineDomain } from "@open-everywhere/core/agent/memory/domain.js";
import { UTILITY_MODEL } from "../../../model/models.js";

export const IT_FIRE_SEAT_DISCORD_SURFACE = "discord/1300000000000000100/1300000001500000014";
export const IT_FIRE_SEAT_SLACK_SURFACE = "slack/T0EXAMPLE/C0EXFIRE001";

export const domain = defineDomain({
  name: "it-fire-seat",
  reach: [IT_FIRE_SEAT_DISCORD_SURFACE, IT_FIRE_SEAT_SLACK_SURFACE],
  memory: "it-fire-seat-brain",
  ambientSupervisor: true,
  mode: "unified",
  engagementTier: "neutral",
  models: { primary: { id: UTILITY_MODEL } },
});
