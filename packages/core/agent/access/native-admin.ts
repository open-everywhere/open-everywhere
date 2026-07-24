export type NativeAdminCheck = (scopeKey: string, principalId: string) => Promise<boolean>;

const REGISTRY = new Map<string, NativeAdminCheck>();

export function registerNativeAdminCheck(platform: string, check: NativeAdminCheck): void {
  REGISTRY.set(platform, check);
}

export function nativeAdminCheck(platform: string | undefined): NativeAdminCheck | undefined {
  return platform === undefined ? undefined : REGISTRY.get(platform);
}
