import { deploymentOrg } from "../../packages/core/agent/identity/deployment-identity.js";
import {
  connectOperatorStore,
  declareOperatorOrg,
  type OperatorStoreTarget,
} from "../../packages/core/scripts/operator-store-connect.js";
import { DeployConfigError } from "./lib.js";

export interface CensusStore {
  readonly target: OperatorStoreTarget;
  readonly org: string;
}

export async function openCensusStore(
  orgFlag: string | undefined,
  connect: () => Promise<OperatorStoreTarget> = connectOperatorStore,
): Promise<CensusStore> {
  declareOperatorOrg(orgFlag);
  const org = deploymentOrg();

  const target = await connect();
  if (target.id !== "postgres" || !target.label.startsWith("hosted Postgres")) {
    throw new DeployConfigError(
      `the operational store this process opened is "${target.label}" — not the deployment's own.\n` +
        "  A census of a local floor store proves nothing about the deployment. Export DATABASE_URL\n" +
        "  (and OE_OPERATIONAL_PROVIDER, if your deployment sets it) and run again.",
    );
  }
  return { target, org };
}
