import type { UnifiedThreadRef, UnifiedWakeOrigin } from "./unified-window.js";
import { admitProviderRegistration } from "../access/provider-selection.js";

export interface WakeOriginCodec<O extends UnifiedWakeOrigin = UnifiedWakeOrigin> {
  validate(o: Record<string, unknown>): boolean;
  threadRef(origin: O): UnifiedThreadRef;
  isThreadScoped(origin: O): boolean;
  containerId(origin: O): string;
  dmOrigin?(binding: DmOriginBinding): O | undefined;
}

export interface DmOriginBinding {
  readonly surface: string;
  readonly threadTs?: string;
  readonly mode: "dm" | "mpim";
}

const WAKE_ORIGIN_CODECS = new Map<string, WakeOriginCodec>();

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
