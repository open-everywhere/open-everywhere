export const LINEAR_SMOKE_ORG = "oe-deploy-smoke-linear-org";

export function linearSmokeTeamId(nowMs: number): string {
  return `oe-deploy-smoke-${nowMs.toString(36)}`;
}

export function linearSmokeSurfaceKey(teamId: string): string {
  return `linear/${LINEAR_SMOKE_ORG}/${teamId}`;
}
