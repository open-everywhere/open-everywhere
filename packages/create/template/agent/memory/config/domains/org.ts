import { defineDomain } from "@open-everywhere/core/agent/memory/domain.js";
import { SUPERVISOR_MODEL, SUPERVISOR_VIA } from "../../../model/models.js";

export const domain = defineDomain({
  name: "org",
  match: "org",
  memory: "org-brain",
  nameDropWake: true,
  admins: [],
  models: { supervisor: { id: SUPERVISOR_MODEL, via: SUPERVISOR_VIA, reasoning: "low" } },
});
