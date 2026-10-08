import {
  encryptedKvVault,
  pageBaseUrl,
  type EncryptedKvVault,
} from "@open-everywhere/core/agent/adapter-api.js";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { SLACK_COOKIE_KEY_REF, SLACK_SETUP_CODE_REF, readInstallRecord, type SlackInstallStateDeps } from "./install-state.js";
import { slackSecretEnvPresent } from "./credentials.js";

export const SETUP_COOKIE_NAME = "__Host-oe-setup";

export const SETUP_COOKIE_TTL_MS = 30 * 60 * 1000;

const SETUP_CODE_BYTES = 16;

const COOKIE_KEY_BYTES = 32;

export interface SlackClaimDeps extends SlackInstallStateDeps {
  readonly vault?: EncryptedKvVault;
  readonly now?: () => number;
  readonly env?: NodeJS.ProcessEnv;
  readonly lockCache?: boolean;
}

function vaultOf(deps: SlackClaimDeps): EncryptedKvVault {
  return deps.vault ?? encryptedKvVault();
}

async function mintedSecret(ref: string, bytes: number, vault: EncryptedKvVault, now: () => number, cache: boolean): Promise<string> {
  const cached = cache ? secretCache.get(ref) : undefined;
  if (cached !== undefined && cached.until > now()) return cached.value;

  return vault.withLock(ref, async () => {
    const stored = await vault.read(ref);
    if (stored !== null) {
      if (cache) secretCache.set(ref, { value: stored, until: now() + SECRET_TTL_MS });
      return stored;
    }
    const minted = randomBytes(bytes).toString("base64url");
    await vault.write(ref, minted, { connector: "slack", createdBy: "host:slack-setup" });
    const confirmed = await vault.read(ref);
    return confirmed ?? minted;
  });
}

const SECRET_TTL_MS = 5_000;

const secretCache = new Map<string, { readonly value: string; readonly until: number }>();

export function resetSlackClaimSecretCache(): void {
  secretCache.clear();
}

async function cookieKey(deps: SlackClaimDeps): Promise<string> {
  return mintedSecret(SLACK_COOKIE_KEY_REF, COOKIE_KEY_BYTES, vaultOf(deps), deps.now ?? Date.now, deps.vault === undefined);
}

export async function slackSetupCode(deps: SlackClaimDeps = {}): Promise<string> {
  return mintedSecret(SLACK_SETUP_CODE_REF, SETUP_CODE_BYTES, vaultOf(deps), deps.now ?? Date.now, deps.vault === undefined);
}

export async function slackSetupOpen(deps: SlackClaimDeps = {}): Promise<boolean> {
  const cacheApplies = deps.vault === undefined || deps.lockCache === true;
  if (cacheApplies && lockCache !== null && lockCache.until > (deps.now ?? Date.now)()) return lockCache.open;

  const env = slackSecretEnvPresent({ ...(deps.env ? { env: deps.env } : {}) });
  if (env.botToken || env.signingSecret) return false;

  const read = await readInstallRecord(deps);
  const open = read.kind === "absent";

  if (cacheApplies) lockCache = { open, until: (deps.now ?? Date.now)() + LOCK_TTL_MS };
  return open;
}

const LOCK_TTL_MS = 5_000;

let lockCache: { readonly open: boolean; readonly until: number } | null = null;

export function resetSlackSetupLockCache(): void {
  lockCache = null;
}

function setupPageUrl(deps: SlackClaimDeps): string {
  const base = pageBaseUrl(deps.env ?? process.env);
  return base === undefined ? "/setup on this deployment's public URL (set OE_PUBLIC_BASE_URL to name it)" : `${base}/setup`;
}

export async function announceSlackSetupCode(deps: SlackClaimDeps = {}): Promise<void> {
  if (!(await slackSetupOpen(deps))) return;
  const code = await slackSetupCode(deps);
  console.log(
    `[open-everywhere:slack-setup] Slack is not installed on this deployment. Open ${setupPageUrl(deps)} and enter this one-time setup code: ${code}\n` +
      `[open-everywhere:slack-setup] The code stops being logged once the Slack install completes, and /setup locks at that point.`,
  );
}

interface SetupCookieClaims {
  readonly v: 1;
  readonly exp: number;
}

function b64urlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return Buffer.alloc(0);
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function sign(secret: string, payloadB64: string): string {
  return b64urlEncode(createHmac("sha256", secret).update(payloadB64, "utf8").digest());
}

export async function mintSetupCookie(deps: SlackClaimDeps = {}): Promise<string> {
  const now = (deps.now ?? Date.now)();
  const claims: SetupCookieClaims = { v: 1, exp: now + SETUP_COOKIE_TTL_MS };
  const payloadB64 = b64urlEncode(Buffer.from(JSON.stringify(claims), "utf8"));
  return `${payloadB64}.${sign(await cookieKey(deps), payloadB64)}`;
}

export async function verifySetupCookie(value: string | undefined, deps: SlackClaimDeps = {}): Promise<boolean> {
  if (typeof value !== "string") return false;
  const dot = value.indexOf(".");
  if (dot <= 0 || dot === value.length - 1) return false;
  const payloadB64 = value.slice(0, dot);
  const sigB64 = value.slice(dot + 1);

  const expected = sign(await cookieKey(deps), payloadB64);
  const a = Buffer.from(sigB64);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;

  let parsed: unknown;
  try {
    const raw = b64urlDecode(payloadB64);
    if (raw.length === 0) return false;
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const c = parsed as Record<string, unknown>;
  if (c.v !== 1) return false;
  if (typeof c.exp !== "number" || !Number.isFinite(c.exp)) return false;
  return c.exp > (deps.now ?? Date.now)();
}

export async function setupCodeMatches(presented: string, deps: SlackClaimDeps = {}): Promise<boolean> {
  const a = Buffer.from(presented.trim());
  const b = Buffer.from(await slackSetupCode(deps));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function setupCookieHeader(value: string): string {
  return `${SETUP_COOKIE_NAME}=${value}; Path=/; Max-Age=${Math.floor(SETUP_COOKIE_TTL_MS / 1000)}; HttpOnly; Secure; SameSite=Lax`;
}

export function setupCookieFrom(req: Request): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    if (part.slice(0, eq).trim() !== SETUP_COOKIE_NAME) continue;
    const value = part.slice(eq + 1).trim();
    return value.length > 0 ? value : undefined;
  }
  return undefined;
}
