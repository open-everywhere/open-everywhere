import { createHash, createSecretKey, randomUUID, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { getOperationalStore } from "../operational/provider.js";
import { authorizationCodeAudience } from "./oauth-clients.js";
import { CONTROL_OAUTH_SIGNING_SECRET, controlSecret } from "./control-secrets.js";

export const OAUTH_SIGNING_SECRET_NAME = CONTROL_OAUTH_SIGNING_SECRET;

export type SigningSecretSource = () => Promise<string | undefined>;

export const storedSigningSecret: SigningSecretSource = () => controlSecret(CONTROL_OAUTH_SIGNING_SECRET);

export const MIN_SIGNING_SECRET_LENGTH = 32;

export const ACCESS_TOKEN_TTL_SECONDS = 600;

export const AUTHORIZATION_CODE_TTL_SECONDS = 60;

const ACCESS_TOKEN_TYPE = "at+jwt";
const AUTHORIZATION_CODE_TYPE = "oe-authz-code+jwt";

export async function oauthSigningSecret(source: SigningSecretSource = storedSigningSecret): Promise<string | null> {
  const raw = ((await source()) ?? "").trim();
  if (raw.length === 0) return null;
  if (raw.length < MIN_SIGNING_SECRET_LENGTH) {
    console.warn(
      `[open-everywhere:control] ${OAUTH_SIGNING_SECRET_NAME} ignored — it must be at least ${MIN_SIGNING_SECRET_LENGTH} characters. The control MCP plane stays off. Value not shown.`,
    );
    return null;
  }
  return raw;
}

function key(secret: string) {
  return createSecretKey(Buffer.from(secret, "utf-8"));
}

export interface AccessTokenInput {
  readonly subject: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
  readonly audience: string;
  readonly issuer: string;
  readonly secret: string;
  readonly now?: Date;
}

export async function mintAccessToken(input: AccessTokenInput): Promise<string> {
  const issuedAt = Math.floor((input.now?.getTime() ?? Date.now()) / 1000);
  return new SignJWT({ scope: input.scopes.join(" "), client_id: input.clientId })
    .setProtectedHeader({ alg: "HS256", typ: ACCESS_TOKEN_TYPE })
    .setIssuer(input.issuer)
    .setAudience(input.audience)
    .setSubject(input.subject)
    .setJti(randomUUID())
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + ACCESS_TOKEN_TTL_SECONDS)
    .sign(key(input.secret));
}

export interface AuthorizationCodeClaims {
  readonly clientId: string;
  readonly subject: string;
  readonly scopes: readonly string[];
  readonly audience: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
}

export async function mintAuthorizationCode(
  claims: AuthorizationCodeClaims,
  opts: { readonly issuer: string; readonly secret: string; readonly now?: Date },
): Promise<string> {
  const issuedAt = Math.floor((opts.now?.getTime() ?? Date.now()) / 1000);
  return new SignJWT({
    scope: claims.scopes.join(" "),
    client_id: claims.clientId,
    aud_resource: claims.audience,
    redirect_uri: claims.redirectUri,
    code_challenge: claims.codeChallenge,
  })
    .setProtectedHeader({ alg: "HS256", typ: AUTHORIZATION_CODE_TYPE })
    .setIssuer(opts.issuer)
    .setAudience(authorizationCodeAudience(opts.issuer))
    .setSubject(claims.subject)
    .setJti(randomUUID())
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + AUTHORIZATION_CODE_TTL_SECONDS)
    .sign(key(opts.secret));
}

export interface VerifiedAuthorizationCode extends AuthorizationCodeClaims {
  readonly jti: string;
}

export async function verifyAuthorizationCode(
  code: string,
  opts: { readonly issuer: string; readonly secret: string },
): Promise<VerifiedAuthorizationCode | null> {
  try {
    const { payload, protectedHeader } = await jwtVerify(code, key(opts.secret), {
      issuer: opts.issuer,
      audience: authorizationCodeAudience(opts.issuer),
      algorithms: ["HS256"],
    });
    if (protectedHeader.typ !== AUTHORIZATION_CODE_TYPE) return null;
    const jti = typeof payload.jti === "string" ? payload.jti : "";
    const subject = typeof payload.sub === "string" ? payload.sub : "";
    const clientId = typeof payload["client_id"] === "string" ? payload["client_id"] : "";
    const audience = typeof payload["aud_resource"] === "string" ? payload["aud_resource"] : "";
    const redirectUri = typeof payload["redirect_uri"] === "string" ? payload["redirect_uri"] : "";
    const codeChallenge = typeof payload["code_challenge"] === "string" ? payload["code_challenge"] : "";
    const scope = typeof payload["scope"] === "string" ? payload["scope"] : "";
    if (!jti || !subject || !clientId || !audience || !redirectUri || !codeChallenge) return null;
    return { jti, subject, clientId, audience, redirectUri, codeChallenge, scopes: scope.split(/\s+/).filter((s) => s.length > 0) };
  } catch {
    return null;
  }
}

export type MarkCodeSpentFn = (org: string, key: string, atIso: string, ttlMs: number) => Promise<boolean>;

export async function redeemAuthorizationCode(
  code: VerifiedAuthorizationCode,
  org: string,
  deps: { readonly markSpent?: MarkCodeSpentFn; readonly now?: Date } = {},
): Promise<boolean> {
  const markSpent = deps.markSpent ?? ((o, k, at, ttl) => getOperationalStore().markEventSeen(o, k, at, ttl));
  try {
    return await markSpent(org, `oauth-code:${code.jti}`, (deps.now ?? new Date()).toISOString(), AUTHORIZATION_CODE_TTL_SECONDS * 1000);
  } catch (err) {
    console.warn(`[open-everywhere:control] authorization-code single-use store unavailable — refusing the exchange (fail-closed): ${String(err)}`);
    return false;
  }
}

export function pkceVerifierMatches(verifier: string, challenge: string): boolean {
  if (!verifier || verifier.length < 43 || verifier.length > 128) return false;
  const expected = base64Url(createHash("sha256").update(verifier, "ascii").digest());
  const a = Buffer.from(expected, "utf-8");
  const b = Buffer.from(challenge, "utf-8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function base64Url(buf: Buffer): string {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
