import { createHash, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTVerifyGetKey } from "jose";
import { getSecretVia } from "../../access/credentials.js";
import type { A2aInboundBearerAuth, A2aInboundCaller, A2aInboundDeclaration, A2aInboundJwtAuth } from "./declaration.js";

export type A2aInboundAuthRefusal = "no-credential" | "invalid-token" | "undeclared-caller";

export type A2aInboundAuthResult = { readonly ok: true; readonly caller: A2aInboundCaller } | { readonly ok: false; readonly reason: A2aInboundAuthRefusal };

const A2A_INBOUND_JWT_ALGORITHMS: readonly string[] = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "EdDSA"];

const CLOCK_TOLERANCE_SECONDS = 60;

export interface A2aInboundAuthDeps {
  readonly jwks?: (jwksUrl: string) => JWTVerifyGetKey;
  readonly secret?: (broker: string, ref: string) => Promise<string>;
  readonly now?: () => number;
}

const JWKS_CACHE = new Map<string, JWTVerifyGetKey>();

export const SECRET_CACHE_TTL_MS = 60_000;
const SECRET_CACHE = new Map<string, { readonly at: number; readonly value: Promise<string | undefined> }>();

export function resetA2aInboundSecretCache(): void {
  SECRET_CACHE.clear();
}

async function cachedSecret(broker: string, ref: string, resolve: (broker: string, ref: string) => Promise<string>, now: number): Promise<string | undefined> {
  const key = `${broker}\n${ref}`;
  const hit = SECRET_CACHE.get(key);
  if (hit !== undefined && now - hit.at < SECRET_CACHE_TTL_MS) return hit.value;
  const value = resolve(broker, ref).then(
    (v) => v,
    () => undefined,
  );
  SECRET_CACHE.set(key, { at: now, value });
  return value;
}

function liveJwks(jwksUrl: string): JWTVerifyGetKey {
  let set = JWKS_CACHE.get(jwksUrl);
  if (set === undefined) {
    set = createRemoteJWKSet(new URL(jwksUrl));
    JWKS_CACHE.set(jwksUrl, set);
  }
  return set;
}

function bearerCredentialOf(header: string | null | undefined): string | undefined {
  if (typeof header !== "string") return undefined;
  const m = /^Bearer[ \t]+([^\s]+)[ \t]*$/iu.exec(header.trim());
  return m?.[1];
}

const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;

function sameSecret(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b) && expected.length > 0;
}

async function authenticateJwt(token: string, callers: readonly A2aInboundCaller[], deps: A2aInboundAuthDeps): Promise<A2aInboundAuthResult> {
  let claimedIssuer: unknown;
  try {
    claimedIssuer = decodeJwt(token).iss;
  } catch {
    return { ok: false, reason: "invalid-token" };
  }
  const jwtCallers = callers.filter((c): c is A2aInboundCaller & { auth: A2aInboundJwtAuth } => c.auth.scheme === "jwt" && c.auth.issuer === claimedIssuer);
  const tried = new Map<string, { readonly sub: string | undefined } | null>();
  for (const c of jwtCallers) {
    const key = `${c.auth.jwksUrl}\n${c.auth.issuer}\n${c.auth.audience}`;
    if (!tried.has(key)) {
      try {
        const { payload } = await jwtVerify(token, (deps.jwks ?? liveJwks)(c.auth.jwksUrl), {
          issuer: c.auth.issuer,
          audience: c.auth.audience,
          algorithms: [...A2A_INBOUND_JWT_ALGORITHMS],
          clockTolerance: CLOCK_TOLERANCE_SECONDS,
          requiredClaims: ["exp", "sub"],
        });
        tried.set(key, { sub: typeof payload.sub === "string" ? payload.sub : undefined });
      } catch {
        tried.set(key, null);
      }
    }
  }
  const verified = [...tried.values()].some((v) => v !== null);
  if (!verified) return { ok: false, reason: "invalid-token" };
  for (const c of jwtCallers) {
    const v = tried.get(`${c.auth.jwksUrl}\n${c.auth.issuer}\n${c.auth.audience}`);
    if (v !== null && v !== undefined && v.sub === c.auth.subject) return { ok: true, caller: c };
  }
  return { ok: false, reason: "undeclared-caller" };
}

async function authenticateBearer(credential: string, callers: readonly A2aInboundCaller[], deps: A2aInboundAuthDeps): Promise<A2aInboundAuthResult> {
  const secretOf = deps.secret ?? getSecretVia;
  let match: A2aInboundCaller | undefined;
  for (const c of callers) {
    if (c.auth.scheme !== "bearer") continue;
    const auth = c.auth as A2aInboundBearerAuth;
    const expected = await cachedSecret(auth.broker ?? "db", auth.secretRef, secretOf, (deps.now ?? Date.now)());
    if (expected === undefined) continue;
    if (sameSecret(credential, expected) && match === undefined) match = c;
  }
  return match === undefined ? { ok: false, reason: "invalid-token" } : { ok: true, caller: match };
}

export async function authenticateA2aInbound(
  authorization: string | null | undefined,
  declaration: A2aInboundDeclaration,
  deps: A2aInboundAuthDeps = {},
): Promise<A2aInboundAuthResult> {
  const credential = bearerCredentialOf(authorization);
  if (credential === undefined) return { ok: false, reason: "no-credential" };
  try {
    if (JWT_SHAPE.test(credential) && declaration.callers.some((c) => c.auth.scheme === "jwt")) {
      const jwt = await authenticateJwt(credential, declaration.callers, deps);
      if (jwt.ok || jwt.reason === "undeclared-caller") return jwt;
    }
    return await authenticateBearer(credential, declaration.callers, deps);
  } catch {
    return { ok: false, reason: "invalid-token" };
  }
}
