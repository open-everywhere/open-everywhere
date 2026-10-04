import type { Caps } from "../../agent/spend/spend.js";

export interface CapDriveFacts {
  readonly droveTheFixture: boolean;
  readonly droveAsNonAdmin: boolean;
  readonly channel: string;
  readonly capFixtureSurfaceKey?: string;
  readonly capFixtureCaps?: Caps;
  readonly attemptedSurfaceKey?: string;
}

export type CapDriveOutcome =
  | { readonly kind: "enforcement-regression"; readonly message: string }
  | { readonly kind: "skip"; readonly reason: string };

export const ADMIN_DRIVER_CLAUSE = "E2E_SLACK_SECONDARY_TOKEN unset";

export function capDriveOutcome(f: CapDriveFacts): CapDriveOutcome {
  if (f.droveTheFixture && f.droveAsNonAdmin) {
    return {
      kind: "enforcement-regression",
      message:
        `the declared channel cap fixture (${f.capFixtureSurfaceKey ?? "(none declared)"}, the perSurface row in agent/spend/budgets.ts: ` +
        `${f.capFixtureCaps ? JSON.stringify(f.capFixtureCaps) : "(row not given)"}) ` +
        `refused nothing in 5 turns, driven by a non-admin identity — spend-cap enforcement regression, unless that row is too wide for 5 turns to reach`,
    };
  }
  if (!f.droveTheFixture) {
    const where = f.capFixtureSurfaceKey
      ? `is not the room the declared cap fixture names (${f.capFixtureSurfaceKey})`
      : f.attemptedSurfaceKey
        ? `no perSurface row in the deployer's agent/spend/budgets.ts caps (S10 looked for ${f.attemptedSurfaceKey} — check its workspace rung against the row)`
        : "no perSurface cap in the deployer's agent/spend/budgets.ts names (the room fixture-inventory-lib.ts CAP_FIXTURES declares, keyed by the driven workspace)";
    return { kind: "skip", reason: `cap never tripped within the 5-turn budget — this drive ran against ${f.channel}, which ${where}, so there is no cap here to trip` };
  }
  return {
    kind: "skip",
    reason:
      `cap never tripped within the 5-turn budget — the drive ran as the ADMIN driver (${ADMIN_DRIVER_CLAUSE}), and spend/bypass.ts admits an org admin ` +
      `past every cap with a warning, so no refusal can post here; set the non-admin secondary identity to make this a hard failure`,
  };
}
