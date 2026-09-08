import { defineDomain } from "@open-everywhere/core/agent/memory/domain.js";
import { UTILITY_MODEL, SUPERVISOR_MODEL } from "../../../model/models.js";

export const domain = defineDomain({
  name: "it-work-read-fixture-teams",
  reach: ["teams/it1064-teams-tenant/it1064-teams-channel"],
  ambientSupervisor: true,
  mode: "unified",
  engagementTier: "neutral",
  reasoningCeiling: "high",
  models: { primary: { id: UTILITY_MODEL }, supervisor: { id: SUPERVISOR_MODEL, reasoning: "medium" } },
  credentials: [{ connector: "teams", credential: "work-token", use: "chat-token" }],
});
