import type { UnifiedThreadRef, UnifiedWakeOrigin } from "./unified-window.js";

export interface WakeOriginCodec<O extends UnifiedWakeOrigin = UnifiedWakeOrigin> {
  validate(o: Record<string, unknown>): boolean;
  threadRef(origin: O): UnifiedThreadRef;
  isThreadScoped(origin: O): boolean;
  containerId(origin: O): string;
}

const WAKE_ORIGIN_CODECS = new Map<string, WakeOriginCodec>();

export function registerWakeOriginCodec<P extends UnifiedWakeOrigin["platform"]>(
  platform: P,
  codec: WakeOriginCodec<Extract<UnifiedWakeOrigin, { platform: P }>>,
): void {
  WAKE_ORIGIN_CODECS.set(platform, codec as WakeOriginCodec);
}

export function wakeOriginCodec(platform: string): WakeOriginCodec | undefined {
  return WAKE_ORIGIN_CODECS.get(platform);
}
