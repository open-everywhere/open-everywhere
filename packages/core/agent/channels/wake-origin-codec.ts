import type { UnifiedThreadRef, UnifiedWakeOrigin } from "./unified-window.js";
import { admitProviderRegistration } from "../access/provider-selection.js";
import { processRegistryMap } from "../lib/process-registry.js";

export interface WakeOriginCodec<O extends UnifiedWakeOrigin = UnifiedWakeOrigin> {
  validate(o: Record<string, unknown>): boolean;
  threadRef(origin: O): UnifiedThreadRef;
  isThreadScoped(origin: O): boolean;
  containerId(origin: O): string;
  carryPlacement?(target: O, source: O): O;
  placementRef?(origin: O): string | undefined;
}

const WAKE_ORIGIN_CODECS = processRegistryMap<WakeOriginCodec>("wake-origin-codecs.v1");

export function registerWakeOriginCodec<P extends UnifiedWakeOrigin["platform"]>(
  platform: P,
  codec: WakeOriginCodec<Extract<UnifiedWakeOrigin, { platform: P }>>,
): void {
  if (!admitProviderRegistration(platform, "wake-origin-codec")) return;
  WAKE_ORIGIN_CODECS.set(platform, codec as WakeOriginCodec);
}

export function wakeOriginCodec(platform: string): WakeOriginCodec | undefined {
  return WAKE_ORIGIN_CODECS.get(platform);
}
