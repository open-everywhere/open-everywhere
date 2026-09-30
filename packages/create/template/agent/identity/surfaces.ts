import { defineSurface, registerSurfaces, type Surface } from "@open-everywhere/core/agent/identity/trust.js";
import {
  registerDeploymentIdentity,
  type DeploymentIdentity,
} from "@open-everywhere/core/agent/identity/deployment-identity.js";

export const deploymentIdentity: DeploymentIdentity = {
  org: "default",
  workspace: "dev",
  surface: "default",
};

export const surfaces: readonly Surface[] = [
];
void defineSurface;

registerSurfaces(surfaces);
registerDeploymentIdentity(deploymentIdentity);
