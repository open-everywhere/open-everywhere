import { channelPlatform, type BindableContext } from "./binding.js";

export interface CapabilityManifest {
  readonly midTurnPost: boolean;
  readonly reactions: boolean;
}

const NONE: CapabilityManifest = { midTurnPost: false, reactions: false };

const MANIFESTS: Record<string, CapabilityManifest> = {};

export function registerCapabilityManifest(platform: string, manifest: CapabilityManifest): void {
  MANIFESTS[platform] = manifest;
}

export function capabilitiesForPlatform(platform: string | undefined): CapabilityManifest {
  return (platform !== undefined ? MANIFESTS[platform] : undefined) ?? NONE;
}

export function capabilitiesFor(ctx: BindableContext): CapabilityManifest {
  return capabilitiesForPlatform(channelPlatform(ctx));
}

registerCapabilityManifest("slack", { midTurnPost: true, reactions: true });
registerCapabilityManifest("discord", { midTurnPost: true, reactions: false });
