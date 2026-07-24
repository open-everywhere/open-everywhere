import { appendAudit, deploymentOrg } from "@open-everywhere/core/agent/adapter-api.js";

const TOKEN_ENDPOINT = "https://api.linear.app/oauth/token";
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const DEFAULT_TTL_SEC = 30 * 24 * 60 * 60;

export type LinearMintFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }>;

interface CachedToken {
  readonly token: string;
  readonly expiresAtMs: number;
}

let cached: CachedToken | undefined;
let inflight: Promise<string> | undefined;

export function _resetLinearMintCache(): void {
  cached = undefined;
  inflight = undefined;
}

export function staticLinearToken(): string | undefined {
  return (
    process.env.LINEAR_AGENT_ACCESS_TOKEN ||
    process.env.LINEAR_ACCESS_TOKEN ||
    process.env.LINEAR_API_KEY ||
    process.env.LINEAR_API_TOKEN ||
    undefined
  );
}

interface LinearTokenResponse {
  readonly access_token?: unknown;
  readonly expires_in?: unknown;
}

export async function mintLinearAppActorToken(
  clientId: string,
  clientSecret: string,
  fetchFn: LinearMintFetch = globalThis.fetch as unknown as LinearMintFetch,
): Promise<CachedToken> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    actor: "app",
    client_id: clientId,
    client_secret: clientSecret,
    scope: "read write app:assignable app:mentionable",
  }).toString();
  let res: { ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> };
  try {
    res = await fetchFn(TOKEN_ENDPOINT, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  } catch (err) {
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
  return { token: data.access_token, expiresAtMs: Date.now() + ttlSec * 1000 };
}

async function auditMintFailure(message: string): Promise<void> {
  console.error(`[open-everywhere:linear-credentials] token mint failed: ${message}`);
  await appendAudit({
    org: deploymentOrg(),
    platform: "linear",
    workspace: "unknown",
    action: "linear.token_mint_failed",
    detail: { error: message.slice(0, 300) },
  }).catch(() => undefined);
}

async function mintedAppActorToken(clientId: string, clientSecret: string): Promise<string> {
  if (cached && cached.expiresAtMs - REFRESH_MARGIN_MS > Date.now()) return cached.token;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const minted = await mintLinearAppActorToken(clientId, clientSecret);
      cached = minted;
      return minted.token;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await auditMintFailure(message);
      throw err;
    } finally {
      inflight = undefined;
    }
  })();
  return inflight;
}

export async function resolveLinearAccessTokenSeam(): Promise<string> {
  const staticToken = staticLinearToken();
  if (staticToken) return staticToken;
  const clientId = process.env.LINEAR_CLIENT_ID;
  const clientSecret = process.env.LINEAR_CLIENT_SECRET;
  if (clientId && clientSecret) return mintedAppActorToken(clientId, clientSecret);
  return "";
}

export const linearAppActorCredentials: { readonly accessToken: () => Promise<string> } = {
  accessToken: resolveLinearAccessTokenSeam,
};

export function linearCredentialsConfigured(): boolean {
  return staticLinearToken() !== undefined || (!!process.env.LINEAR_CLIENT_ID && !!process.env.LINEAR_CLIENT_SECRET);
}
