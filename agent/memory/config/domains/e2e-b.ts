import { defineDomain } from "@open-everywhere/core/agent/memory/domain.js";
import { UTILITY_MODEL } from "../../../model/models.js";

export const domain = defineDomain({
  name: "e2e-b",
  reach: ["slack/T0EXAMPLE/C0EXCHAN005"],
  memory: "e2e-b-brain",
  models: { primary: { id: UTILITY_MODEL } },
});

export const enabled = (): boolean => process.env.OE_MEMORY_EVAL !== "1";
