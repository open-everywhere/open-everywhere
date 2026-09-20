import { defineDomain } from "@open-everywhere/core/agent/memory/domain.js";
import { UTILITY_MODEL, SUPERVISOR_MODEL } from "../../../model/models.js";
import { E2E_NOTION_SURFACE } from "../fixture-surfaces.js";

const E2E_NOTION_OWN_ACCOUNT_SURFACE = "notion/40000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000105";

export const domain = defineDomain({
  name: "e2e-unified",
  reach: ["slack/T0EXAMPLE/C0EXCHAN003", "slack/T0EXAMPLE/C0EXRANDM", "github/example-owner/e2e-scratch", "discord/1300000000000000100/1300000000000000101", "teams/7e5a0000-0000-4000-8000-000000000001/19-0exampleTeamsChannel00000000000000001-thread.tacv2", "linear/1a000000-0000-4000-8000-000000000001/1a000000-0000-4000-8000-000000000011",
    E2E_NOTION_OWN_ACCOUNT_SURFACE,
    ...(process.env.OE_MEMORY_EVAL === "1" ? [] : [E2E_NOTION_SURFACE])],
  memory: "e2e-ambient-brain",
  ambientSupervisor: true,
  mode: "unified",
  engagementTier: "neutral",
  reasoningCeiling: "high",
  models: { primary: { id: UTILITY_MODEL }, supervisor: { id: SUPERVISOR_MODEL, reasoning: "medium" } },
  credentialGrants: ["notion"],
  credentials: [
    { connector: "slack", credential: "work-token", use: "chat-token" },
    { connector: "linear", credential: "workspace", use: "1a000000-0000-4000-8000-000000000001" },
  ],
});
