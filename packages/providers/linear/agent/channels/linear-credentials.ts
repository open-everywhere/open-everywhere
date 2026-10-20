import { getSettings, operatorSecretOrUnset, warmCredential, withRetryAfterLoose, RateLimitExhaustedError } from "@open-everywhere/core/agent/adapter-api.js";
import type { BrokeredSecret, RetryPolicy } from "@open-everywhere/core/agent/adapter-api.js";

const TOKEN_ENDPOINT = "https://api.linear.app/oauth/token";
const DEFAULT_TTL_SEC = 30 * 24 * 60 * 60;

export type LinearMintFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }>;

const linearAppActorToken = warmCredential<{ clientId: string; clientSecret: string; cacheKey: string }>({
  name: "linear.app-actor",
  platform: "linear",
  auditAction: "linear.token_mint_failed",
  refresh: "re-mint",
  fallbackTtlSeconds: DEFAULT_TTL_SEC,
  key: ({ cacheKey }) => cacheKey,
  mint: ({ clientId, clientSecret }) => mintLinearAppActorToken(clientId, clientSecret),
});

export function _resetLinearMintCache(): void {
  linearAppActorToken.reset();
}

const LINEAR_STATIC_TOKEN_NAMES = ["LINEAR_AGENT_ACCESS_TOKEN", "LINEAR_ACCESS_TOKEN", "LINEAR_API_KEY", "LINEAR_API_TOKEN"] as const;

export async function staticLinearToken(): Promise<string | undefined> {
  for (const name of LINEAR_STATIC_TOKEN_NAMES) {
    const value = await operatorSecretOrUnset(name);
    if (value) return value;
  }
  return undefined;
}

export const linearStaticTokenCredentials: { readonly accessToken: () => Promise<string> } = {
  accessToken: async () => (await staticLinearToken()) ?? "",
};

const LINEAR_CLIENT_SECRET_NAME = "LINEAR_CLIENT_SECRET";

async function primaryLinearClientSecret(): Promise<string | undefined> {
  return await operatorSecretOrUnset(LINEAR_CLIENT_SECRET_NAME);
}

interface LinearTokenResponse {
  readonly access_token?: unknown;
  readonly expires_in?: unknown;
}

export async function mintLinearAppActorToken(
  clientId: string,
  clientSecret: string,
  fetchFn: LinearMintFetch = globalThis.fetch as unknown as LinearMintFetch,
  retry?: RetryPolicy,
): Promise<BrokeredSecret> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    actor: "app",
    client_id: clientId,
    client_secret: clientSecret,
    scope: "read write app:assignable app:mentionable",
  }).toString();
  let res: { ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> };
  try {
    res = await withRetryAfterLoose(
      () => fetchFn(TOKEN_ENDPOINT, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }),
      { ...retry, surface: "linear", operation: "oauth.token" },
    );
  } catch (err) {
    if (err instanceof RateLimitExhaustedError) throw err;
    throw new Error(`Linear client-credentials mint failed — network error calling ${TOKEN_ENDPOINT}: ${String(err)}`);
  }
  if (!res.ok) {
    throw new Error(`Linear client-credentials mint failed — HTTP ${res.status} from ${TOKEN_ENDPOINT}.`);
  }
  let data: LinearTokenResponse;
  try {
    data = (await res.json()) as LinearTokenResponse;
  } catch (err) {
    throw new Error(`Linear client-credentials mint failed — response body was not valid JSON: ${String(err)}`);
  }
  if (typeof data.access_token !== "string" || data.access_token.length === 0) {
    throw new Error("Linear client-credentials mint failed — response carried no access_token.");
  }
  const ttlSec = typeof data.expires_in === "number" && Number.isFinite(data.expires_in) && data.expires_in > 0 ? data.expires_in : DEFAULT_TTL_SEC;
  return { value: data.access_token, expiresAtMs: Date.now() + ttlSec * 1000 };
}

const APP_SLOT_PREFIX = "LINEAR_APP_";
const APP_ORG_SUFFIX = "_ORG_ID";

export interface LinearAppEntry {
  readonly slot: string;
  readonly organizationId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly webhookSecret?: string;
}

export function primaryLinearOrganizationId(): string | undefined {
  return getSettings().linear.organizationId || undefined;
}

function primaryLinearClientId(): string | undefined {
  return getSettings().linear.clientId || undefined;
}

export function linearAppRegistry(env: NodeJS.ProcessEnv = process.env): readonly LinearAppEntry[] {
  const entries: LinearAppEntry[] = [];
  for (const name of Object.keys(env)) {
    if (!name.startsWith(APP_SLOT_PREFIX) || !name.endsWith(APP_ORG_SUFFIX)) continue;
    const slot = name.slice(APP_SLOT_PREFIX.length, name.length - APP_ORG_SUFFIX.length);
    if (!/^[A-Z0-9]+$/.test(slot)) continue;
    const organizationId = env[name];
    const clientId = env[`${APP_SLOT_PREFIX}${slot}_CLIENT_ID`];
    const clientSecret = env[`${APP_SLOT_PREFIX}${slot}_CLIENT_SECRET`];
    const webhookSecret = env[`${APP_SLOT_PREFIX}${slot}_WEBHOOK_SECRET`];
    if (!organizationId || !clientId || !clientSecret) continue;
    entries.push({ slot, organizationId, clientId, clientSecret, ...(webhookSecret ? { webhookSecret } : {}) });
  }
  return entries;
}

export function linearAppForOrg(organizationId: string | undefined, env: NodeJS.ProcessEnv = process.env): LinearAppEntry | undefined {
  if (!organizationId) return undefined;
  return linearAppRegistry(env).find((a) => a.organizationId === organizationId);
}

export async function resolveLinearAccessTokenForOrg(organizationId?: string): Promise<string> {
  const app = linearAppForOrg(organizationId);
  if (app) return linearAppActorToken.get({ clientId: app.clientId, clientSecret: app.clientSecret, cacheKey: app.organizationId });
  const primaryOrg = primaryLinearOrganizationId();
  if (organizationId && primaryOrg && organizationId !== primaryOrg) return "";
  const staticToken = await staticLinearToken();
  if (staticToken) return staticToken;
  const clientId = primaryLinearClientId();
  const clientSecret = clientId ? await primaryLinearClientSecret() : undefined;
  if (clientId && clientSecret) return linearAppActorToken.get({ clientId, clientSecret, cacheKey: "" });
  return "";
}

export async function resolveLinearAccessTokenSeam(): Promise<string> {
  return resolveLinearAccessTokenForOrg(undefined);
}

export const linearAppActorCredentials: { readonly accessToken: () => Promise<string> } = {
  accessToken: resolveLinearAccessTokenSeam,
};

export function linearCredentialsForOrg(organizationId: string | undefined): { readonly accessToken: () => Promise<string> } {
  if (!organizationId) return linearAppActorCredentials;
  return { accessToken: () => resolveLinearAccessTokenForOrg(organizationId) };
}

export async function linearCredentialsConfigured(): Promise<boolean> {
  if (linearAppRegistry().length > 0) return true;
  if ((await staticLinearToken()) !== undefined) return true;
  return !!primaryLinearClientId() && !!(await primaryLinearClientSecret());
}
