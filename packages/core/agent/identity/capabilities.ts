import { channelPlatform, type BindableContext } from "./binding.js";
import { admitProviderRegistration } from "../access/provider-selection.js";
import { processRegistryMap } from "../lib/process-registry.js";

export interface CapabilityManifest {
  readonly midTurnPost: boolean;
  readonly reactions: boolean;
  readonly supervisorProseDropped?: boolean;
}

const NONE: CapabilityManifest = { midTurnPost: false, reactions: false };

const MANIFESTS = processRegistryMap<CapabilityManifest>("capability-manifests.v1");

export function registerCapabilityManifest(platform: string, manifest: CapabilityManifest): void {
  if (!admitProviderRegistration(platform, "capability-manifest")) return;
  MANIFESTS.set(platform, manifest);
}

export function capabilitiesForPlatform(platform: string | undefined): CapabilityManifest {
  return (platform !== undefined ? MANIFESTS.get(platform) : undefined) ?? NONE;
}

export function capabilitiesFor(ctx: BindableContext): CapabilityManifest {
  return capabilitiesForPlatform(channelPlatform(ctx));
}
