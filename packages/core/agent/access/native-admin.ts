import { admitProviderRegistration } from "./provider-selection.js";

export type NativeAdminCheck = (scopeKey: string, principalId: string) => Promise<boolean>;

const REGISTRY = new Map<string, NativeAdminCheck>();

export function registerNativeAdminCheck(platform: string, check: NativeAdminCheck): void {
  if (!admitProviderRegistration(platform, "native-admin-check")) return;
  REGISTRY.set(platform, check);
}

export function nativeAdminCheck(platform: string | undefined): NativeAdminCheck | undefined {
  return platform === undefined ? undefined : REGISTRY.get(platform);
}
