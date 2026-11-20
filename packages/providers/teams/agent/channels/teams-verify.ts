// Bot Framework inbound request verification for the Teams front. eve 1.0 keeps its own verifier
// internal, so the provider owns this one. It follows eve 1.0.0-rc.18's checks (Copyright 2026
// Vercel, Inc. and contributors, Apache-2.0, `src/public/channels/teams/verify`), and the Open
// Everywhere authors wrote it on `jose`. Every failure THROWS: the front answers 401 and forwards
// nothing.
import { importJWK, jwtVerify, type JWK, type JWTHeaderParameters, type JWTPayload } from "jose";
import { resolveTeamsAppId, type TeamsCredentialValue } from "./teams-credentials.js";

/** The one signing algorithm the Bot Connector service uses. The verifier admits no other. */
const BOT_CONNECTOR_ALGORITHM = "RS256";
const BOT_CONNECTOR_ISSUER = "https://api.botframework.com";
const BOT_CONNECTOR_OPENID_METADATA_URL = "https://login.botframework.com/v1/.well-known/openidconfiguration";
const DEFAULT_MAX_SKEW_SECONDS = 300;

export type TeamsVerifyFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface TeamsVerifyOptions {
  readonly appId: TeamsCredentialValue | undefined;
  readonly fetch?: TeamsVerifyFetch;
  readonly jwksUrl?: string;
  readonly openIdMetadataUrl?: string;
  /** The allowed clock skew, in seconds. Five minutes when unset. */
  readonly maxSkewSeconds?: number;
}

export interface VerifiedTeamsRequest {
  readonly body: string;
  /** The `serviceurl` claim of the verified token. The activity must name this service URL. */
  readonly serviceUrl: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBearerToken(header: string): string | null {
  const [scheme, token] = header.split(/\s+/, 2);
  return scheme?.toLowerCase() !== "bearer" || !token ? null : token;
}

async function loadJwksUrl(options: TeamsVerifyOptions, fetchImpl: TeamsVerifyFetch): Promise<string> {
  const res = await fetchImpl(options.openIdMetadataUrl ?? BOT_CONNECTOR_OPENID_METADATA_URL, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Teams OpenID metadata route returned HTTP ${res.status}.`);
  const body: unknown = await res.json();
  if (!isRecord(body) || typeof body.jwks_uri !== "string") throw new Error("Teams OpenID metadata response is missing jwks_uri.");
  return body.jwks_uri;
}

async function loadJwks(options: TeamsVerifyOptions): Promise<readonly Record<string, unknown>[]> {
  const fetchImpl = options.fetch ?? (globalThis.fetch as TeamsVerifyFetch);
  const res = await fetchImpl(options.jwksUrl ?? (await loadJwksUrl(options, fetchImpl)), { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Teams JWKS route returned HTTP ${res.status}.`);
  const body: unknown = await res.json();
  if (!isRecord(body) || !Array.isArray(body.keys)) throw new Error("Teams JWKS response is malformed.");
  return body.keys.filter(isRecord);
}

function selectJwk(keys: readonly Record<string, unknown>[], header: JWTHeaderParameters): JWK {
  const kid = typeof header.kid === "string" ? header.kid : undefined;
  const x5t = typeof header.x5t === "string" ? header.x5t : undefined;
  const key = keys.find((k) => (kid !== undefined && k.kid === kid) || (x5t !== undefined && k.x5t === x5t)) ?? (keys.length === 1 ? keys[0] : undefined);
  if (key === undefined) throw new Error("Teams inbound JWT key was not found in JWKS.");
  return key as JWK;
}

/**
 * Verifies one Bot Connector JWT: an RS256 signature by a key from the Bot Connector JWKS, the
 * Bot Framework issuer, the app id as audience, and the time claims within the allowed skew. A
 * token signed with any other algorithm, `none` included, is refused before a key is chosen.
 */
async function verifyTeamsJwt(token: string, options: TeamsVerifyOptions): Promise<JWTPayload> {
  const audience = await resolveTeamsAppId(options.appId);
  // jose skips the audience check when the audience is empty, so an empty app id must refuse here.
  if (!audience) throw new Error("Teams app id resolved to an empty string: refusing every inbound token.");
  const keys = await loadJwks(options);
  const { payload } = await jwtVerify(token, async (header) => importJWK(selectJwk(keys, header), BOT_CONNECTOR_ALGORITHM), {
    algorithms: [BOT_CONNECTOR_ALGORITHM],
    audience,
    issuer: BOT_CONNECTOR_ISSUER,
    clockTolerance: options.maxSkewSeconds ?? DEFAULT_MAX_SKEW_SECONDS,
  });
  return payload;
}

/**
 * Verifies an inbound Teams request and returns its body with the token's service URL. Throws when
 * the bearer token is missing, the token fails {@link verifyTeamsJwt}, or the token has no
 * `serviceurl` claim.
 */
export async function verifyTeamsRequest(request: Request, options: TeamsVerifyOptions): Promise<VerifiedTeamsRequest> {
  const body = await request.text();
  const token = readBearerToken(request.headers.get("authorization") ?? "");
  if (!token) throw new Error("Teams inbound request is missing its bearer token.");
  const payload = await verifyTeamsJwt(token, options);
  if (typeof payload.serviceurl !== "string") throw new Error("Teams verified token is missing its service URL claim.");
  return { body, serviceUrl: payload.serviceurl };
}

/**
 * The Teams front's verifier. It runs {@link verifyTeamsRequest}, then binds the activity to the
 * token: a body that is JSON with a `serviceUrl` other than the token's claim is refused, as eve's
 * own Teams channel refuses it. A body that is not JSON passes here, and the front forwards it
 * unread to eve, which answers it.
 */
export async function verifyTeamsInbound(request: Request, options: TeamsVerifyOptions): Promise<string> {
  const verified = await verifyTeamsRequest(request, options);
  let parsed: unknown;
  try {
    parsed = JSON.parse(verified.body);
  } catch {
    return verified.body;
  }
  if (!isRecord(parsed) || parsed.serviceUrl !== verified.serviceUrl) {
    throw new Error("Teams activity service URL does not match the verified token.");
  }
  return verified.body;
}
