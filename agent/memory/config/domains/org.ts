import { defineDomain } from "@open-everywhere/core/agent/memory/domain.js";
import { SUPERVISOR_MODEL } from "../../../model/models.js";

export const domain = defineDomain({ name: "org", match: "org", memory: "org-brain", nameDropWake: true,
  ambientSupervisor: false,
  admins: ["slack/T0EXAMPLE/U0EXOWNER", "slack/T0EXAMPLE/U0EXUSER002", "discord/300000000000000104"],
  models: { supervisor: { id: SUPERVISOR_MODEL, reasoning: "low" } } });
