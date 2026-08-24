import { admitProviderRegistration } from "../access/provider-selection.js";
import { processRegistryMap } from "../lib/process-registry.js";

export interface AccountProfile {
  readonly name?: string;
  readonly handle?: string;
}

export type AccountDisplayNameArm = (nativeId: string, tenant?: string) => Promise<AccountProfile | undefined>;

const ARMS = processRegistryMap<AccountDisplayNameArm>("account-display-name.v1");

export function registerAccountDisplayName(platform: string, arm: AccountDisplayNameArm): void {
  if (!admitProviderRegistration(platform, "account-display-name")) return;
  ARMS.set(platform, arm);
}

export function _resetAccountDisplayNamesForTest(): void {
  ARMS.clear();
  CACHE.clear();
}

export const ACCOUNT_NAME_MAX_LEN = 80;

export function sanitizeFragment(raw: string): string {
  const stripped = raw
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length > ACCOUNT_NAME_MAX_LEN ? `${stripped.slice(0, ACCOUNT_NAME_MAX_LEN)}…` : stripped;
}

export const ACCOUNT_NAME_CACHE_CAP = 1000;

let ACCOUNT_ARM_TIMEOUT_MS = 3000;

export function _setAccountArmTimeoutMsForTest(ms: number): void {
  ACCOUNT_ARM_TIMEOUT_MS = ms;
}

export function _resetAccountArmTimeoutMsForTest(): void {
  ACCOUNT_ARM_TIMEOUT_MS = 3000;
}

function cacheKey(platform: string, tenant: string | undefined, nativeId: string): string {
  return `${platform}\u0000${tenant ?? ""}\u0000${nativeId}`;
}

const CACHE = new Map<string, Promise<AccountProfile | undefined>>();

const TIMED_OUT = Symbol("account-display-name.timed-out");

async function resolveViaArm(arm: AccountDisplayNameArm, nativeId: string, tenant: string | undefined): Promise<AccountProfile | undefined | typeof TIMED_OUT> {
  try {
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      const t = setTimeout(() => resolve(TIMED_OUT), ACCOUNT_ARM_TIMEOUT_MS);
      t.unref?.();
    });
    const result = await Promise.race([arm(nativeId, tenant), timeout]);
    if (result === TIMED_OUT) return TIMED_OUT;
    if (!result) return undefined;
    const name = typeof result.name === "string" ? sanitizeFragment(result.name) : "";
    const handle = typeof result.handle === "string" ? sanitizeFragment(result.handle) : "";
    if (!name && !handle) return undefined;
    return { ...(name ? { name } : {}), ...(handle ? { handle } : {}) };
  } catch {
    return undefined;
  }
}

export function accountProfileFor(platform: string, nativeId: string, tenant?: string): Promise<AccountProfile | undefined> {
  const key = cacheKey(platform, tenant, nativeId);
  const cached = CACHE.get(key);
  if (cached) return cached;

  const arm = ARMS.get(platform);
  const settled: Promise<AccountProfile | undefined> = !arm
    ? Promise.resolve(undefined)
    : resolveViaArm(arm, nativeId, tenant).then((result) => {
        if (result !== TIMED_OUT) return result;
        CACHE.delete(key);
        return undefined;
      });

  if (CACHE.size >= ACCOUNT_NAME_CACHE_CAP) {
    const oldest = CACHE.keys().next().value;
    if (oldest !== undefined) CACHE.delete(oldest);
  }
  CACHE.set(key, settled);
  return settled;
}

export function composedAccountName(profile: AccountProfile | undefined): string | undefined {
  if (!profile) return undefined;
  return profile.name && profile.handle && profile.name !== profile.handle
    ? `${profile.name} (@${profile.handle})`
    : (profile.name ?? (profile.handle ? `@${profile.handle}` : undefined));
}

export async function humanAccountLabel(platform: string, nativeId: string, tenant?: string): Promise<string> {
  const profile = await accountProfileFor(platform, nativeId, tenant);
  const fallback = `the ${platform} account "${nativeId}"`;
  const named = composedAccountName(profile);
  if (!named) return fallback;
  const workspace = tenant && tenant.length > 0 ? `${platform}/${tenant}` : platform;
  return `${named} (${nativeId}) on ${workspace}`;
}
