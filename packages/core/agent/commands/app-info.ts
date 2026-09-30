export interface AppInfo {
  readonly version: string;
  readonly primaryModel: string;
  readonly utilityModel: string;
  readonly contextWindowTokens?: number;
  readonly compactionThresholdTokens?: number;
  readonly deploymentSha: string;
  readonly evePin: string;
}

export const APP_VERSION_UNVERSIONED = "unversioned";

const UNVERSIONED_PLACEHOLDER = "0.0.0";

export function normalizeAppVersion(raw: string): string {
  const v = raw.trim();
  if (v === "" || v === UNVERSIONED_PLACEHOLDER) return APP_VERSION_UNVERSIONED;
  return v;
}

export function hasRealAppVersion(info: AppInfo): boolean {
  return info.version !== APP_VERSION_UNVERSIONED && info.version !== "unknown";
}

const UNKNOWN_APP_INFO: AppInfo = {
  version: "unknown",
  primaryModel: "unknown",
  utilityModel: "unknown",
  deploymentSha: "unknown",
  evePin: "unknown",
};
let registeredAppInfo: AppInfo = UNKNOWN_APP_INFO;

export function registerAppInfo(info: AppInfo): void {
  registeredAppInfo = { ...info, version: normalizeAppVersion(info.version) };
}

export function getAppInfo(): AppInfo {
  return registeredAppInfo;
}

export function resetAppInfo(): void {
  registeredAppInfo = UNKNOWN_APP_INFO;
}
