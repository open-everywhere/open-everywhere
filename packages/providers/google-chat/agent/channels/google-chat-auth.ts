import { createRemoteJWKSet, importPKCS8, jwtVerify, SignJWT, type JWTVerifyGetKey } from "jose";
import { getOperatorSecret } from "@open-everywhere/core/agent/adapter-api.js";
import type { GoogleChatAudience } from "../policy.js";

export const CHAT_ISSUER_ACCOUNT = "chat@system.gserviceaccount.com";
const CHAT_SYSTEM_JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/chat@system.gserviceaccount.com";
const GOOGLE_OIDC_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_OIDC_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const CHAT_BOT_SCOPE = "https://www.googleapis.com/auth/chat.bot";
export const SERVICE_ACCOUNT_SECRET = "GOOGLE_CHAT_SERVICE_ACCOUNT_KEY";

export type GoogleChatTokenVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface GoogleChatVerifyDeps {
  readonly chatSystemKeys?: JWTVerifyGetKey;
  readonly googleOidcKeys?: JWTVerifyGetKey;
}

let liveChatKeys: JWTVerifyGetKey | undefined;
let liveOidcKeys: JWTVerifyGetKey | undefined;

function bearer(authorization: string | undefined): string | undefined {
  const m = /^Bearer\s+([A-Za-z0-9._-]+)$/u.exec(authorization?.trim() ?? "");
  return m?.[1];
}

export async function verifyGoogleChatToken(
  authorization: string | undefined,
  audience: GoogleChatAudience | null,
  deps: GoogleChatVerifyDeps = {},
): Promise<GoogleChatTokenVerdict> {
  if (audience === null) return { ok: false, reason: "no audience is configured" };
  const token = bearer(authorization);
  if (token === undefined) return { ok: false, reason: "no bearer token" };
  try {
    if (audience.kind === "project-number") {
      const keys = deps.chatSystemKeys ?? (liveChatKeys ??= createRemoteJWKSet(new URL(CHAT_SYSTEM_JWKS_URL)));
      await jwtVerify(token, keys, { issuer: CHAT_ISSUER_ACCOUNT, audience: audience.projectNumber, algorithms: ["RS256"] });
      return { ok: true };
    }
    const keys = deps.googleOidcKeys ?? (liveOidcKeys ??= createRemoteJWKSet(new URL(GOOGLE_OIDC_JWKS_URL)));
    const { payload } = await jwtVerify(token, keys, { issuer: GOOGLE_OIDC_ISSUERS, audience: audience.url, algorithms: ["RS256"] });
    if (payload["email"] !== CHAT_ISSUER_ACCOUNT || payload["email_verified"] !== true) {
      return { ok: false, reason: "the token is not Google Chat's" };
    }
    return { ok: true };
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    return { ok: false, reason: `the token did not verify${typeof code === "string" ? ` (${code})` : ""}` };
  }
}

interface ServiceAccountKey {
  readonly clientEmail: string;
  readonly privateKey: string;
}

export function parseServiceAccountKey(raw: string): ServiceAccountKey {
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    throw new Error(`${SERVICE_ACCOUNT_SECRET} is not JSON.`);
  }
  const o = (typeof j === "object" && j !== null ? j : {}) as Record<string, unknown>;
  if (o["type"] !== "service_account" || typeof o["client_email"] !== "string" || typeof o["private_key"] !== "string") {
    throw new Error(`${SERVICE_ACCOUNT_SECRET} is not a Google service-account key.`);
  }
  return { clientEmail: o["client_email"], privateKey: o["private_key"] };
}

export interface GoogleChatTokenDeps {
  readonly fetch?: typeof fetch;
  readonly serviceAccountKey?: () => Promise<string>;
  readonly now?: () => number;
}

let cached: { readonly token: string; readonly expiresAt: number; readonly account: string } | undefined;

export function resetGoogleChatTokenCache(): void {
  cached = undefined;
}

export async function googleChatAccessToken(deps: GoogleChatTokenDeps = {}): Promise<string> {
  const now = (deps.now ?? Date.now)();
  const key = parseServiceAccountKey(await (deps.serviceAccountKey ?? (async () => (await getOperatorSecret(SERVICE_ACCOUNT_SECRET)).value))());
  if (cached && cached.account === key.clientEmail && cached.expiresAt - 60_000 > now) return cached.token;
  let signingKey: CryptoKey;
  try {
    signingKey = await importPKCS8(key.privateKey, "RS256");
  } catch {
    throw new Error(`${SERVICE_ACCOUNT_SECRET} holds a private key that does not import.`);
  }
  const iat = Math.floor(now / 1000);
  const assertion = await new SignJWT({ scope: CHAT_BOT_SCOPE })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(key.clientEmail)
    .setAudience(GOOGLE_TOKEN_URL)
    .setIssuedAt(iat)
    .setExpirationTime(iat + 3600)
    .sign(signingKey);
  const res = await (deps.fetch ?? fetch)(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
  });
  if (!res.ok) throw new Error(`the Google token endpoint refused the service-account grant (HTTP ${res.status}).`);
  const body = (await res.json().catch(() => ({}))) as { access_token?: unknown; expires_in?: unknown };
  if (typeof body.access_token !== "string" || body.access_token === "") throw new Error("the Google token endpoint returned no access token.");
  const ttl = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600;
  cached = { token: body.access_token, expiresAt: now + ttl * 1000, account: key.clientEmail };
  return body.access_token;
}
