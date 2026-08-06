import { defineSurface, registerSurfaces } from "@open-everywhere/core/agent/identity/trust.js";

export const surfaces = [
  defineSurface({ key: "discord/1300000000000000100", trust: "internal" }),

  defineSurface({ key: "discord/300000000000000104", trust: "internal" }),

  defineSurface({ key: "teams/7e5a0000-0000-4000-8000-000000000001/19-0exampleTeamsChannel00005119784069361745884-thread.tacv2", trust: "internal" }),

  defineSurface({ key: "linear/1a000000-0000-4000-8000-000000000001", trust: "internal" }),
  defineSurface({ key: "linear/1a000000-0000-4000-8000-000000000001/1a000000-0000-4000-8000-000000000011", trust: "internal" }),
  defineSurface({ key: "notion/40000000-0000-4000-8000-000000000001", trust: "internal" }),
  defineSurface({ key: "notion/40000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000101", trust: "internal" }),

  defineSurface({ key: "github/example-owner", trust: "internal" }),
  defineSurface({ key: "github/example-owner/e2e-scratch", trust: "internal" }),
] as const;

registerSurfaces(surfaces);
