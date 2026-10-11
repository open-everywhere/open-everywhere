import { defineDomain } from "@open-everywhere/core/agent/memory/domain.js";

export const domain = defineDomain({
  name: "e2e-linear-signed-delivery",
  reach: ["linear/oe-deploy-smoke-linear-org/oe-deploy-smoke-*"],
  mode: "solo",
  externalPolicy: { roomGrain: "silent" },
});
