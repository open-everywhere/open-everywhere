import type { IncomingMessage } from "node:http";
import { adminAuthenticatorFromEnv, SERVICE_TOKEN_ISSUER, type AdminIdentity } from "./auth.js";
import {
  CONTROL_OAUTH_CLIENTS,
  CONTROL_OAUTH_ISSUER,
  clientSecretMatches,
  controlOAuthAudiences,
  findControlOAuthClient,
  grantedScopes,
  parseScopeString,
  resolveAudience,
  SCOPE_CONTROL_ADMIN,
  SCOPE_CONTROL_DOMAIN_PREFIX,
  SCOPE_CONTROL_WRITE,
  type ControlOAuthClient,
} from "./oauth-clients.js";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  mintAccessToken,
  mintAuthorizationCode,
  oauthSigningSecret,
  pkceVerifierMatches,
  redeemAuthorizationCode,
  verifyAuthorizationCode,
  type MarkCodeSpentFn,
} from "./oauth-tokens.js";
import { CONTROL_ADVERTISED_SCOPES, CONTROL_MCP_PATH, controlMcpResource, controlOAuthIssuer, controlProtectedResourceMetadata } from "./oauth-resource.js";
import { appendAudit } from "../audit/audit.js";
import { deploymentOrg } from "../identity/binding.js";
import type { AuditDetail } from "../audit/scrubbed-text.js";

export const CONTROL_OAUTH_AUTHORIZE_PATH = "/control/v1/oauth/authorize";
export const CONTROL_OAUTH_TOKEN_PATH = "/control/v1/oauth/token";
export const CONTROL_OAUTH_SERVER_METADATA_PATH = "/.well-known/oauth-authorization-server";

export interface ControlOAuthDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly clients?: readonly ControlOAuthClient[];
  readonly issuer?: string;
  readonly adminIdentity?: (req: Request) => Promise<AdminIdentity | null>;
  readonly markCodeSpent?: MarkCodeSpentFn;
  readonly now?: Date;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
}

function oauthError(status: number, code: string, description: string, headers: Record<string, string> = {}): Response {
  return json(status, { error: code, error_description: description }, headers);
}

const NOT_FOUND = () => new Response("not found", { status: 404 });

function armed(deps: ControlOAuthDeps): { secret: string; issuer: string } | null {
  const secret = oauthSigningSecret(deps.env ?? process.env);
  const issuer = controlOAuthIssuer(deps.issuer ?? CONTROL_OAUTH_ISSUER);
  return secret === null || issuer === null ? null : { secret, issuer };
}

export function handleAuthorizationServerMetadata(_req: Request, deps: ControlOAuthDeps = {}): Response {
  const live = armed(deps);
  if (live === null) return NOT_FOUND();
  const issuer = live.issuer;
  return json(200, {
    issuer,
    authorization_endpoint: new URL(CONTROL_OAUTH_AUTHORIZE_PATH, issuer).toString(),
    token_endpoint: new URL(CONTROL_OAUTH_TOKEN_PATH, issuer).toString(),
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "client_credentials"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
    scopes_supported: CONTROL_ADVERTISED_SCOPES,
    resource_indicators_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: "https://github.com/open-everywhere/open-everywhere/blob/main/docs/security/control-plane.md#control-plane-mcp-over-https-oauth-21",
  });
}

export function handleProtectedResourceMetadata(_req: Request, deps: ControlOAuthDeps = {}): Response {
  const doc = controlProtectedResourceMetadata(deps.env ?? process.env, deps.issuer ?? CONTROL_OAUTH_ISSUER);
  if (doc === null) return NOT_FOUND();
  return json(200, doc, { "access-control-allow-origin": "*" });
}

function asIncomingMessage(req: Request): IncomingMessage {
  const authorization = req.headers.get("authorization") ?? undefined;
  return { headers: { authorization } } as unknown as IncomingMessage;
}

async function resolveAdminIdentity(req: Request, deps: ControlOAuthDeps): Promise<AdminIdentity | null> {
  if (deps.adminIdentity) return deps.adminIdentity(req);
  let authenticate: ((req: IncomingMessage) => Promise<AdminIdentity | null>) | null = null;
  try {
    authenticate = adminAuthenticatorFromEnv();
  } catch {
    return null;
  }
  if (!authenticate) return null;
  return authenticate(asIncomingMessage(req)).catch(() => null);
}

export function scopesAllowedForIdentity(identity: AdminIdentity): string[] {
  const allowed: string[] = [];
  if (identity.readOnly !== true) allowed.push(SCOPE_CONTROL_WRITE);
  for (const role of identity.roles) {
    if (role === "admin") allowed.push(SCOPE_CONTROL_ADMIN);
    else if (role.startsWith("domain:")) allowed.push(`${SCOPE_CONTROL_DOMAIN_PREFIX}${role.slice("domain:".length)}`);
  }
  return allowed;
}

export async function handleAuthorize(req: Request, deps: ControlOAuthDeps = {}): Promise<Response> {
  const live = armed(deps);
  if (live === null) return NOT_FOUND();
  const { secret, issuer } = live;

  const url = new URL(req.url);
  const q = (name: string): string => (url.searchParams.get(name) ?? "").trim();

  const client = findControlOAuthClient(q("client_id"), deps.clients ?? CONTROL_OAUTH_CLIENTS);
  if (!client || client.grant !== "authorization_code") {
    return oauthError(400, "invalid_client", "unknown client_id, or the client is not registered for the authorization_code grant");
  }
  const redirectUri = q("redirect_uri");
  if (!client.redirectUris.includes(redirectUri)) {
    return oauthError(400, "invalid_request", "redirect_uri does not exactly match a registered redirect URI for this client");
  }
  const state = q("state");
  const fail = (code: string, description: string): Response => redirectError(redirectUri, code, description, state);

  if (q("response_type") !== "code") return fail("unsupported_response_type", "only response_type=code is supported");
  if (q("code_challenge_method") !== "S256") return fail("invalid_request", "code_challenge_method must be S256");
  const codeChallenge = q("code_challenge");
  if (codeChallenge.length < 43) return fail("invalid_request", "code_challenge is missing or too short for S256");
  const audience = resolveAudience(url.searchParams.get("resource"), controlOAuthAudiences(controlMcpResource(issuer), issuer));
  if (audience === null) return fail("invalid_target", "the requested resource is not served by this deployment");

  const identity = await resolveAdminIdentity(req, deps);
  if (!identity) {
    return oauthError(401, "access_denied", "authorize requires a credential this deployment's admin door accepts", {
      "www-authenticate": 'Bearer realm="open-everywhere-control"',
    });
  }

  if (identity.issuer === SERVICE_TOKEN_ISSUER) {
    await audit("control.oauth_refused", identity.subject, { grant: "authorization_code", reason: "service_token_family_refused" });
    return oauthError(403, "access_denied", "a service token cannot authorize a control-plane client — register a client_credentials client instead");
  }

  const allowed = scopesAllowedForIdentity(identity);
  const requested = parseScopeString(url.searchParams.get("scope"));
  const asked = requested.length > 0 ? requested : client.scopes.filter((s) => allowed.includes(s));
  const subject = `${identity.issuer}#${identity.subject}`;
  if (asked.length === 0 || !asked.every((s) => allowed.includes(s) && client.scopes.includes(s))) {
    await audit("control.oauth_refused", subject, { grant: "authorization_code", reason: "invalid_scope", client: client.clientId });
    return fail("invalid_scope", "the requested scope exceeds this client's registration or this identity's roles");
  }

  const code = await mintAuthorizationCode(
    { clientId: client.clientId, subject, scopes: asked, audience, redirectUri, codeChallenge },
    { issuer, secret, ...(deps.now ? { now: deps.now } : {}) },
  );
  await audit("control.oauth_code_issued", subject, { client: client.clientId, scope: asked.join(" ") });

  const location = new URL(redirectUri);
  location.searchParams.set("code", code);
  if (state) location.searchParams.set("state", state);
  location.searchParams.set("iss", issuer);
  return new Response(null, { status: 302, headers: { location: location.toString(), "cache-control": "no-store" } });
}

function redirectError(redirectUri: string, code: string, description: string, state: string): Response {
  const location = new URL(redirectUri);
  location.searchParams.set("error", code);
  location.searchParams.set("error_description", description);
  if (state) location.searchParams.set("state", state);
  return new Response(null, { status: 302, headers: { location: location.toString(), "cache-control": "no-store" } });
}

export async function handleToken(req: Request, deps: ControlOAuthDeps = {}): Promise<Response> {
  const live = armed(deps);
  if (live === null) return NOT_FOUND();
  const { secret } = live;

  let form: URLSearchParams;
  try {
    form = new URLSearchParams(await req.text());
  } catch {
    return oauthError(400, "invalid_request", "expected an application/x-www-form-urlencoded body");
  }
  const f = (name: string): string => (form.get(name) ?? "").trim();

  const grantType = f("grant_type");
  if (grantType === "client_credentials") return tokenByClientCredentials(req, form, secret, deps);
  if (grantType === "authorization_code") return tokenByAuthorizationCode(form, secret, deps);
  return oauthError(400, "unsupported_grant_type", `grant_type must be client_credentials or authorization_code (got "${grantType || "none"}")`);
}

function clientCredentialsFromRequest(req: Request, form: URLSearchParams): { clientId: string; clientSecret: string } {
  const header = req.headers.get("authorization") ?? "";
  const basic = /^Basic\s+(.+)$/i.exec(header.trim());
  if (basic) {
    try {
      const decoded = Buffer.from(basic[1], "base64").toString("utf-8");
      const at = decoded.indexOf(":");
      if (at > 0) {
        return { clientId: decodeURIComponent(decoded.slice(0, at)), clientSecret: decodeURIComponent(decoded.slice(at + 1)) };
      }
    } catch {
      return { clientId: "", clientSecret: "" };
    }
  }
  return { clientId: (form.get("client_id") ?? "").trim(), clientSecret: form.get("client_secret") ?? "" };
}

async function tokenByClientCredentials(req: Request, form: URLSearchParams, secret: string, deps: ControlOAuthDeps): Promise<Response> {
  const { clientId, clientSecret } = clientCredentialsFromRequest(req, form);
  const client = findControlOAuthClient(clientId, deps.clients ?? CONTROL_OAUTH_CLIENTS);
  const authenticated = client !== null && client.grant === "client_credentials" && clientSecretMatches(clientSecret, client);
  if (!authenticated || client === null) {
    if (client !== null) await audit("control.oauth_refused", `oauth-client:${client.clientId}`, { grant: "client_credentials", reason: "invalid_client" });
    return oauthError(401, "invalid_client", "client authentication failed", { "www-authenticate": 'Basic realm="open-everywhere-control"' });
  }
  return issueAccessToken(client, parseScopeString(form.get("scope")), form.get("resource"), `oauth-client:${client.clientId}`, secret, deps);
}

async function tokenByAuthorizationCode(form: URLSearchParams, secret: string, deps: ControlOAuthDeps): Promise<Response> {
  const f = (name: string): string => (form.get(name) ?? "").trim();
  const client = findControlOAuthClient(f("client_id"), deps.clients ?? CONTROL_OAUTH_CLIENTS);
  if (!client || client.grant !== "authorization_code") {
    return oauthError(401, "invalid_client", "client authentication failed");
  }
  const verified = await verifyAuthorizationCode(f("code"), { issuer: controlOAuthIssuer(deps.issuer ?? CONTROL_OAUTH_ISSUER) ?? "", secret });
  const bound =
    verified !== null &&
    verified.clientId === client.clientId &&
    verified.redirectUri === f("redirect_uri") &&
    pkceVerifierMatches(f("code_verifier"), verified.codeChallenge);
  if (!verified || !bound) {
    await audit("control.oauth_refused", `oauth-client:${client.clientId}`, { grant: "authorization_code", reason: "invalid_grant" });
    return oauthError(400, "invalid_grant", "the authorization code is invalid, expired, or does not match this request");
  }
  const spent = await redeemAuthorizationCode(verified, deploymentOrg(), {
    ...(deps.markCodeSpent ? { markSpent: deps.markCodeSpent } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });
  if (!spent) {
    await audit("control.oauth_refused", verified.subject, { grant: "authorization_code", reason: "code_replayed_or_store_unavailable" });
    return oauthError(400, "invalid_grant", "the authorization code is invalid, expired, or does not match this request");
  }
  return issueAccessToken(client, verified.scopes, verified.audience, verified.subject, secret, deps);
}

async function issueAccessToken(
  client: ControlOAuthClient,
  requested: readonly string[],
  resource: string | null,
  subject: string,
  secret: string,
  deps: ControlOAuthDeps,
): Promise<Response> {
  const scopes = grantedScopes(requested, client);
  if (scopes === null) {
    await audit("control.oauth_refused", subject, { grant: client.grant, reason: "invalid_scope" });
    return oauthError(400, "invalid_scope", "the requested scope exceeds this client's registration");
  }
  const issuer = controlOAuthIssuer(deps.issuer ?? CONTROL_OAUTH_ISSUER) ?? "";
  const audience = resolveAudience(resource, controlOAuthAudiences(controlMcpResource(issuer), issuer));
  if (audience === null) {
    await audit("control.oauth_refused", subject, { grant: client.grant, reason: "invalid_target" });
    return oauthError(400, "invalid_target", "the requested resource is not served by this deployment");
  }
  const token = await mintAccessToken({
    subject,
    clientId: client.clientId,
    scopes,
    audience,
    issuer,
    secret,
    ...(deps.now ? { now: deps.now } : {}),
  });
  await audit("control.oauth_token_issued", subject, { client: client.clientId, grant: client.grant, scope: scopes.join(" "), audience });
  return json(200, { access_token: token, token_type: "Bearer", expires_in: ACCESS_TOKEN_TTL_SECONDS, scope: scopes.join(" ") });
}

async function audit(action: string, principalId: string, detail: AuditDetail): Promise<void> {
  await appendAudit({ org: deploymentOrg(), platform: "control", workspace: "control", principalId, action, detail });
}
