import { OeOauthError } from "./errors.js";

export type OAuthFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface DiscoveredEndpoints {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly registrationEndpoint: string;
  readonly revocationEndpoint?: string;
}

export interface OAuthTokenResponse {
  readonly access_token: string;
  readonly refresh_token?: string;
  readonly expires_in?: number;
  readonly scope?: string;
  readonly token_type?: string;
}

function trimSlash(u: string): string {
  return u.replace(/\/+$/, "");
}

function wellKnownUrl(base: string, suffix: string): string {
  const u = new URL(base);
  const path = trimSlash(u.pathname) === "" ? "" : trimSlash(u.pathname);
  return `${u.origin}/.well-known/${suffix}${path}`;
}

async function readError(res: Response): Promise<{ oauthError?: string }> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body?.error === "string" ? { oauthError: body.error } : {};
  } catch {
    return {};
  }
}

export async function discoverEndpoints(resource: string, fetchImpl: OAuthFetch): Promise<DiscoveredEndpoints> {
  const base = trimSlash(resource);
  let prMeta = await fetchImpl(wellKnownUrl(base, "oauth-protected-resource"), { headers: { accept: "application/json" } });
  if (!prMeta.ok) {
    const rootForm = `${new URL(base).origin}/.well-known/oauth-protected-resource`;
    if (wellKnownUrl(base, "oauth-protected-resource") !== rootForm) {
      prMeta = await fetchImpl(rootForm, { headers: { accept: "application/json" } });
    }
  }
  if (!prMeta.ok) throw new OeOauthError(`protected-resource discovery failed for ${base}`, { httpStatus: prMeta.status, ...(await readError(prMeta)) });
  const pr = (await prMeta.json().catch(() => ({}))) as { authorization_servers?: unknown };
  const authServer = Array.isArray(pr.authorization_servers) && typeof pr.authorization_servers[0] === "string" ? (pr.authorization_servers[0] as string) : undefined;
  if (!authServer) throw new OeOauthError(`protected-resource metadata for ${base} names no authorization_servers`);

  const asBase = trimSlash(authServer);
  const asMeta = await fetchImpl(wellKnownUrl(asBase, "oauth-authorization-server"), { headers: { accept: "application/json" } });
  if (!asMeta.ok) throw new OeOauthError(`authorization-server discovery failed for ${asBase}`, { httpStatus: asMeta.status, ...(await readError(asMeta)) });
  const as = (await asMeta.json().catch(() => ({}))) as {
    authorization_endpoint?: unknown;
    token_endpoint?: unknown;
    registration_endpoint?: unknown;
    revocation_endpoint?: unknown;
  };
  const authorizationEndpoint = typeof as.authorization_endpoint === "string" ? as.authorization_endpoint : undefined;
  const tokenEndpoint = typeof as.token_endpoint === "string" ? as.token_endpoint : undefined;
  const registrationEndpoint = typeof as.registration_endpoint === "string" ? as.registration_endpoint : undefined;
  const revocationEndpoint = typeof as.revocation_endpoint === "string" && as.revocation_endpoint ? as.revocation_endpoint : undefined;
  if (!authorizationEndpoint || !tokenEndpoint || !registrationEndpoint) {
    throw new OeOauthError(`authorization-server metadata for ${asBase} is missing authorization/token/registration endpoints`);
  }
  return { authorizationEndpoint, tokenEndpoint, registrationEndpoint, ...(revocationEndpoint ? { revocationEndpoint } : {}) };
}

export async function registerClient(
  registrationEndpoint: string,
  input: { readonly clientName: string; readonly redirectUri: string; readonly scopes?: readonly string[] },
  fetchImpl: OAuthFetch,
): Promise<{ readonly clientId: string }> {
  const res = await fetchImpl(registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: input.clientName,
      redirect_uris: [input.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(input.scopes && input.scopes.length ? { scope: input.scopes.join(" ") } : {}),
    }),
  });
  if (!res.ok) throw new OeOauthError(`dynamic client registration failed at ${registrationEndpoint}`, { httpStatus: res.status, ...(await readError(res)) });
  const body = (await res.json().catch(() => ({}))) as { client_id?: unknown };
  if (typeof body.client_id !== "string" || !body.client_id) throw new OeOauthError(`registration response carried no client_id`);
  return { clientId: body.client_id };
}

export function buildAuthorizationUrl(input: {
  readonly authorizationEndpoint: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly codeChallenge: string;
  readonly resource: string;
  readonly scopes?: readonly string[];
}): string {
  const u = new URL(input.authorizationEndpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", input.clientId);
  u.searchParams.set("redirect_uri", input.redirectUri);
  u.searchParams.set("state", input.state);
  u.searchParams.set("code_challenge", input.codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("resource", input.resource);
  if (input.scopes && input.scopes.length) u.searchParams.set("scope", input.scopes.join(" "));
  return u.toString();
}

async function readTokenResponse(tokenEndpoint: string, res: Response): Promise<OAuthTokenResponse> {
  if (!res.ok) {
    const { oauthError } = await readError(res);
    throw new OeOauthError(`token endpoint ${tokenEndpoint} returned ${res.status}${oauthError ? ` (${oauthError})` : ""}`, {
      httpStatus: res.status,
      ...(oauthError ? { oauthError } : {}),
    });
  }
  const body = (await res.json().catch(() => ({}))) as OAuthTokenResponse;
  if (typeof body.access_token !== "string" || !body.access_token) throw new OeOauthError(`token endpoint ${tokenEndpoint} returned no access_token`);
  return body;
}

async function postToken(tokenEndpoint: string, form: Record<string, string>, fetchImpl: OAuthFetch): Promise<OAuthTokenResponse> {
  const res = await fetchImpl(tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form).toString(),
  });
  return readTokenResponse(tokenEndpoint, res);
}

export function exchangeCode(
  tokenEndpoint: string,
  input: { readonly code: string; readonly verifier: string; readonly clientId: string; readonly redirectUri: string; readonly resource: string },
  fetchImpl: OAuthFetch,
): Promise<OAuthTokenResponse> {
  return postToken(
    tokenEndpoint,
    {
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: input.clientId,
      code_verifier: input.verifier,
      resource: input.resource,
    },
    fetchImpl,
  );
}

export async function revokeToken(
  revocationEndpoint: string,
  input: { readonly token: string; readonly clientId: string; readonly tokenTypeHint?: "refresh_token" | "access_token" },
  fetchImpl: OAuthFetch,
): Promise<void> {
  const res = await fetchImpl(revocationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      token: input.token,
      client_id: input.clientId,
      ...(input.tokenTypeHint ? { token_type_hint: input.tokenTypeHint } : {}),
    }).toString(),
  });
  if (!res.ok) {
    const { oauthError } = await readError(res);
    throw new OeOauthError(`revocation endpoint ${revocationEndpoint} returned ${res.status}${oauthError ? ` (${oauthError})` : ""}`, {
      httpStatus: res.status,
      ...(oauthError ? { oauthError } : {}),
    });
  }
}

export interface ConfidentialClient {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly bodyEncoding: "json" | "form";
  readonly headers?: Readonly<Record<string, string>>;
}

export function basicAuthHeader(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`, "utf-8").toString("base64")}`;
}

export function buildStaticAuthorizationUrl(input: {
  readonly authorizationEndpoint: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly scopes?: readonly string[];
  readonly extraParams?: Readonly<Record<string, string>>;
}): string {
  const u = new URL(input.authorizationEndpoint);
  for (const [k, v] of Object.entries(input.extraParams ?? {})) u.searchParams.set(k, v);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", input.clientId);
  u.searchParams.set("redirect_uri", input.redirectUri);
  u.searchParams.set("state", input.state);
  if (input.scopes && input.scopes.length) u.searchParams.set("scope", input.scopes.join(" "));
  return u.toString();
}

function vendorHeaders(client: ConfidentialClient, owned: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(client.headers ?? {})) {
    if (!owned.includes(name.toLowerCase())) out[name] = value;
  }
  return out;
}

const OWNED_TOKEN_HEADERS = ["accept", "content-type", "authorization"] as const;

async function postTokenConfidential(
  tokenEndpoint: string,
  client: ConfidentialClient,
  params: Record<string, string>,
  fetchImpl: OAuthFetch,
): Promise<Response> {
  const headers: Record<string, string> = vendorHeaders(client, OWNED_TOKEN_HEADERS);
  headers.accept = "application/json";
  headers["content-type"] = client.bodyEncoding === "json" ? "application/json" : "application/x-www-form-urlencoded";
  headers.authorization = basicAuthHeader(client.clientId, client.clientSecret);
  return fetchImpl(tokenEndpoint, {
    method: "POST",
    headers,
    body: client.bodyEncoding === "json" ? JSON.stringify(params) : new URLSearchParams(params).toString(),
    redirect: "error",
  });
}

export async function exchangeCodeConfidential(
  tokenEndpoint: string,
  input: { readonly code: string; readonly redirectUri: string },
  client: ConfidentialClient,
  fetchImpl: OAuthFetch,
): Promise<OAuthTokenResponse> {
  const res = await postTokenConfidential(tokenEndpoint, client, { grant_type: "authorization_code", code: input.code, redirect_uri: input.redirectUri }, fetchImpl);
  return readTokenResponse(tokenEndpoint, res);
}

export async function refreshTokenConfidential(
  tokenEndpoint: string,
  input: { readonly refreshToken: string; readonly scopes?: readonly string[] },
  client: ConfidentialClient,
  fetchImpl: OAuthFetch,
): Promise<OAuthTokenResponse> {
  const res = await postTokenConfidential(
    tokenEndpoint,
    client,
    { grant_type: "refresh_token", refresh_token: input.refreshToken, ...(input.scopes && input.scopes.length ? { scope: input.scopes.join(" ") } : {}) },
    fetchImpl,
  );
  return readTokenResponse(tokenEndpoint, res);
}

export async function revokeTokenConfidential(
  revocationEndpoint: string,
  input: { readonly token: string; readonly tokenTypeHint?: "refresh_token" | "access_token" },
  client: ConfidentialClient,
  fetchImpl: OAuthFetch,
): Promise<void> {
  const headers: Record<string, string> = vendorHeaders(client, OWNED_TOKEN_HEADERS);
  headers.accept = "application/json";
  headers["content-type"] = "application/x-www-form-urlencoded";
  headers.authorization = basicAuthHeader(client.clientId, client.clientSecret);
  const res = await fetchImpl(revocationEndpoint, {
    method: "POST",
    headers,
    body: new URLSearchParams({ token: input.token, ...(input.tokenTypeHint ? { token_type_hint: input.tokenTypeHint } : {}) }).toString(),
    redirect: "error",
  });
  if (!res.ok) {
    const { oauthError } = await readError(res);
    throw new OeOauthError(`revocation endpoint ${revocationEndpoint} returned ${res.status}${oauthError ? ` (${oauthError})` : ""}`, {
      httpStatus: res.status,
      ...(oauthError ? { oauthError } : {}),
    });
  }
}

export function refreshToken(
  tokenEndpoint: string,
  input: { readonly refreshToken: string; readonly clientId: string; readonly resource: string; readonly scopes?: readonly string[] },
  fetchImpl: OAuthFetch,
): Promise<OAuthTokenResponse> {
  return postToken(
    tokenEndpoint,
    {
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
      client_id: input.clientId,
      resource: input.resource,
      ...(input.scopes && input.scopes.length ? { scope: input.scopes.join(" ") } : {}),
    },
    fetchImpl,
  );
}
