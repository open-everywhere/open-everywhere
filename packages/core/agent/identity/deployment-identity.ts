import { processRegistrySlot } from "../lib/process-registry.js";

const SAFE = /[^a-zA-Z0-9._-]+/g;

export function seg(value: string | undefined, fallback: string): string {
  const cleaned = (value ?? "").trim().replace(SAFE, "-").replace(/^[-.]+|[-.]+$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 100) : fallback;
}

export interface DeploymentIdentity {
  readonly org?: string;
  readonly workspace?: string;
  readonly surface?: string;
}

const SLOT = processRegistrySlot<DeploymentIdentity>("deployment-identity.v1");

export function registerDeploymentIdentity(input: DeploymentIdentity): void {
  SLOT.set({ org: input.org, workspace: input.workspace, surface: input.surface });
}

export function _setDeploymentIdentityForTest(patch: Partial<DeploymentIdentity>): void {
  const current = SLOT.get() ?? {};
  SLOT.set({
    org: Object.hasOwn(patch, "org") ? patch.org : current.org,
    workspace: Object.hasOwn(patch, "workspace") ? patch.workspace : current.workspace,
    surface: Object.hasOwn(patch, "surface") ? patch.surface : current.surface,
  });
}

export function _resetDeploymentIdentityForTest(): void {
  SLOT.set(null);
}

export function registeredDeploymentIdentity(): DeploymentIdentity | undefined {
  return SLOT.get() ?? undefined;
}

export function deploymentOrg(): string {
  return seg(SLOT.get()?.org, "default");
}

export function ambientWorkspace(): string | undefined {
  return SLOT.get()?.workspace;
}

export function ambientSurface(): string | undefined {
  return SLOT.get()?.surface;
}
