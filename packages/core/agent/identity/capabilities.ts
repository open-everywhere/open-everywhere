import { channelPlatform, type BindableContext } from "./binding.js";

export interface CapabilityManifest {
  readonly midTurnPost: boolean;
  readonly reactions: boolean;
}

const NONE: CapabilityManifest = { midTurnPost: false, reactions: false };

const MANIFESTS: Readonly<Record<string, CapabilityManifest>> = {
  slack: { midTurnPost: true, reactions: true },
  discord: { midTurnPost: true, reactions: false },
  teams: { midTurnPost: true, reactions: false },
  linear: { midTurnPost: true, reactions: false },
  github: { midTurnPost: false, reactions: false },
  telegram: { midTurnPost: true, reactions: false },
  notion: { midTurnPost: true, reactions: false },
};

export function capabilitiesForPlatform(platform: string | undefined): CapabilityManifest {
  return (platform !== undefined ? MANIFESTS[platform] : undefined) ?? NONE;
}

export function capabilitiesFor(ctx: BindableContext): CapabilityManifest {
  return capabilitiesForPlatform(channelPlatform(ctx));
}
