import { defineDomain } from "@open-everywhere/core/agent/memory/domain.js";
import { SUPERVISOR_MODEL } from "../../../model/models.js";

export const domain = defineDomain({
  name: "org",
  match: "org",
  memory: "org-brain",
  nameDropWake: true,
  admins: [],
  models: { supervisor: { id: SUPERVISOR_MODEL, reasoning: "low" } },
});
