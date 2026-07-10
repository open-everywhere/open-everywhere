import { channelPlatform, type BindableContext } from "./binding.js";

export interface CapabilityManifest {
  readonly midTurnPost: boolean;
  readonly silentEdit: boolean;
  readonly reactions: boolean;
}

const NONE: CapabilityManifest = { midTurnPost: false, silentEdit: false, reactions: false };

const MANIFESTS: Readonly<Record<string, CapabilityManifest>> = {
  slack: { midTurnPost: true, silentEdit: true, reactions: true },
  discord: { midTurnPost: true, silentEdit: true, reactions: false },
  teams: { midTurnPost: false, silentEdit: false, reactions: false },
  linear: { midTurnPost: false, silentEdit: false, reactions: false },
  github: { midTurnPost: false, silentEdit: false, reactions: false },
  telegram: { midTurnPost: false, silentEdit: false, reactions: false },
  notion: { midTurnPost: true, silentEdit: false, reactions: false },
};

export function capabilitiesForPlatform(platform: string | undefined): CapabilityManifest {
  return (platform !== undefined ? MANIFESTS[platform] : undefined) ?? NONE;
}

export function capabilitiesFor(ctx: BindableContext): CapabilityManifest {
  return capabilitiesForPlatform(channelPlatform(ctx));
}
