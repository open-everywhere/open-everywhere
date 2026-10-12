import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";

export interface VerifiedIdToken {
  readonly sub: string;
}

export async function verifyOidcIdToken(
  idToken: string,
  opts: { readonly jwks: JSONWebKeySet; readonly issuer: string; readonly audience: string; readonly nonce: string },
): Promise<VerifiedIdToken> {
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(idToken, createLocalJWKSet(opts.jwks), { issuer: opts.issuer, audience: opts.audience }));
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    throw new Error(`the IdP id token did not verify${typeof code === "string" ? ` (${code})` : ""}`);
  }
  if (payload["nonce"] !== opts.nonce) throw new Error("the IdP id token did not verify (nonce mismatch)");
  const sub = payload["sub"];
  if (typeof sub !== "string" || sub === "") throw new Error("the IdP id token names no subject");
  return { sub };
}
