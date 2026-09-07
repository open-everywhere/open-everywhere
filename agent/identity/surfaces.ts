import { defineSurface, registerSurfaces, type Surface } from "@open-everywhere/core/agent/identity/trust.js";
import { teamsVouchedKeys } from "./teams-vouched-keys.js";

export const surfaces: readonly Surface[] = [
  defineSurface({ key: "discord/1300000000000000100", trust: "internal" }),

  defineSurface({ key: "discord/300000000000000104", trust: "internal" }),

  ...teamsVouchedKeys().map((key) => defineSurface({ key, trust: "internal" })),

  defineSurface({ key: "linear/1a000000-0000-4000-8000-000000000001", trust: "internal" }),
  defineSurface({ key: "linear/1a000000-0000-4000-8000-000000000001/1a000000-0000-4000-8000-000000000011", trust: "internal" }),
  defineSurface({ key: "notion/40000000-0000-4000-8000-000000000001", trust: "internal" }),
  defineSurface({ key: "notion/40000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000101", trust: "internal" }),

  defineSurface({ key: "github/example-owner", trust: "internal" }),
  defineSurface({ key: "github/example-owner/e2e-scratch", trust: "internal" }),

  defineSurface({ key: "linear/1a000000-0000-4000-8000-000000000002", trust: "internal" }),
  defineSurface({
    key: "linear/1a000000-0000-4000-8000-000000000002/1a000000-0000-4000-8000-000000000013",
    trust: "internal",
  }),

  defineSurface({ key: "linear/oe-deploy-smoke-linear-org/oe-deploy-smoke-*", trust: "public" }),
];

registerSurfaces(surfaces);
