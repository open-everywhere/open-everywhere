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

export type NativeMemberCheck = (scopeKey: string, principalId: string) => Promise<boolean>;

const MEMBER_REGISTRY = new Map<string, NativeMemberCheck>();

export function registerNativeMemberCheck(platform: string, check: NativeMemberCheck): void {
  if (!admitProviderRegistration(platform, "native-member-check")) return;
  MEMBER_REGISTRY.set(platform, check);
}

export function nativeMemberCheck(platform: string | undefined): NativeMemberCheck | undefined {
  return platform === undefined ? undefined : MEMBER_REGISTRY.get(platform);
}
