import { defineDomain } from "@open-everywhere/core/agent/memory/domain.js";
import { UTILITY_MODEL } from "../../../model/models.js";

export const domain = defineDomain({ name: "dm", match: "dm", includeOrg: "readonly", models: { primary: { id: UTILITY_MODEL } } });
