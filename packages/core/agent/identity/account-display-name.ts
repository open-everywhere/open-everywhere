import { admitProviderRegistration } from "../access/provider-selection.js";
import { processRegistryMap } from "../lib/process-registry.js";

export interface AccountProfile {
  readonly name?: string;
  readonly handle?: string;
  readonly email?: string;
}

function verifiedEmail(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.trim();
  return /^[^\s@<>|()[\]]+@[^\s@<>|()[\]]+\.[^\s@<>|()[\]]+$/.test(v) && v.length <= 254 ? v : undefined;
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
  // eslint-disable-next-line no-control-regex -- deliberately matching the control-character range
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
    const email = verifiedEmail(result.email);
    if (!name && !handle && !email) return undefined;
    return { ...(name ? { name } : {}), ...(handle ? { handle } : {}), ...(email ? { email } : {}) };
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

const PLATFORM_LABEL: Readonly<Record<string, string>> = { slack: "Slack", discord: "Discord", teams: "Microsoft Teams", github: "GitHub", linear: "Linear", notion: "Notion", email: "email" };

function platformLabel(platform: string): string {
  return PLATFORM_LABEL[platform] ?? platform;
}

export function linkMarkup(url: string, text: string, surface: string | undefined): string {
  if (url.startsWith("slack://") && surface !== "slack") return text;
  if (surface === "slack") return `<${url}|${text.replace(/[|<>]/g, " ").replace(/\s+/g, " ").trim()}>`;
  if (surface === "discord" || surface === "teams" || surface === "github" || surface === "linear") return `[${text.replace(/[[\]()]/g, " ").replace(/\s+/g, " ").trim()}](${url})`;
  return text;
}

export function profileUrl(platform: string, nativeId: string, tenant: string | undefined, profile: AccountProfile | undefined): string | undefined {
  switch (platform) {
    case "discord":
      return /^\d{17,20}$/.test(nativeId) ? `https://discord.com/users/${nativeId}` : undefined;
    case "slack":
      return tenant && /^[TE]\w+$/.test(tenant) && /^[UW]\w+$/.test(nativeId) ? `slack://user?team=${tenant}&id=${nativeId}` : undefined;
    case "github": {
      const login = profile?.handle ?? (/^\d+$/.test(nativeId) ? undefined : nativeId);
      return login && /^[A-Za-z0-9-]{1,39}$/.test(login) ? `https://github.com/${login}` : undefined;
    }
    case "teams":
      return profile?.email ? `https://teams.microsoft.com/l/chat/0/0?users=${encodeURIComponent(profile.email)}` : undefined;
    default:
      return undefined;
  }
}

function verifier(platform: string, nativeId: string, profile: AccountProfile | undefined): string | undefined {
  if (profile?.email) return profile.email;
  if (platform === "discord" && profile?.handle) return `@${profile.handle}`;
  if (platform === "github") {
    const login = profile?.handle ?? (/^\d+$/.test(nativeId) ? undefined : nativeId);
    return login ? `@${login}` : undefined;
  }
  return undefined;
}

export interface AccountLinkParts {
  readonly text: string;
  readonly linked: boolean;
  readonly verified: boolean;
}

export async function accountLinkParts(account: { readonly platform: string; readonly nativeId: string; readonly tenant?: string }, surface: string | undefined): Promise<AccountLinkParts> {
  const profile = await accountProfileFor(account.platform, account.nativeId, account.tenant);
  const uniqueHandle = account.platform === "discord" || account.platform === "github";
  const name = (uniqueHandle ? (profile?.name ?? profile?.handle) : composedAccountName(profile)) ?? `a ${platformLabel(account.platform)} account`;
  const url = profileUrl(account.platform, account.nativeId, account.tenant, profile);
  const markup = url ? linkMarkup(url, name, surface) : name;
  const linked = markup !== name;
  const check = verifier(account.platform, account.nativeId, profile);
  const shown = check !== undefined && name.replace(/^@/, "").toLowerCase() !== check.replace(/^@/, "").toLowerCase();
  return { text: shown ? `${markup} (${check})` : markup, linked, verified: check !== undefined };
}

export async function accountLinkLabel(account: { readonly platform: string; readonly nativeId: string; readonly tenant?: string }, surface: string | undefined): Promise<string> {
  return (await accountLinkParts(account, surface)).text;
}

export async function humanAccountLabel(platform: string, nativeId: string, tenant?: string, surface?: string): Promise<string> {
  return `${await accountLinkLabel({ platform, nativeId, ...(tenant ? { tenant } : {}) }, surface)} on ${platformLabel(platform)}`;
}
