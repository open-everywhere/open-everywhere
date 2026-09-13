import { defineDomain } from "@open-everywhere/core/agent/memory/domain.js";
import { UTILITY_MODEL, SUPERVISOR_MODEL } from "../../../model/models.js";

export const domain = defineDomain({
  name: "soak",
  reach: [
    "notion/40000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000102",
    "notion/40000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000103",
    "slack/T0EXAMPLE/C0EXCHAN008",
    "slack/T0EXAMPLE/C0EXCHAN009",
    "github/example-owner/soak-scratch",
    "linear/1a000000-0000-4000-8000-000000000002/1a000000-0000-4000-8000-000000000013",
  ],
  memory: "soak-brain",
  ambientSupervisor: true,
  mode: "unified",
  engagementTier: "neutral",
  models: { primary: { id: UTILITY_MODEL }, supervisor: { id: SUPERVISOR_MODEL, reasoning: "medium" } },
  credentials: [
    { connector: "notion", credential: "team-key", use: "channel-key" },
    { connector: "linear", credential: "workspace", use: "1a000000-0000-4000-8000-000000000002" },
    { connector: "slack", credential: "work-token", use: "chat-token" },
  ],
});
