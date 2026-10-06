import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";
import type { ControlOAuthClient } from "../agent/control/oauth-clients.js";
import { removeTempDir } from "./_temp-dir.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const dir = join(tmpdir(), `open-everywhere-control-oauth-test-${process.pid}`);
await removeTempDir(dir);
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
_setDeploymentIdentityForTest({ org: "acme" });
delete process.env.OE_CONTROL_OAUTH_SIGNING_SECRET;
for (const v of ["OE_ADMIN_OIDC_ISSUER", "OE_ADMIN_OIDC_AUDIENCE", "OE_ADMIN_GITHUB", "OE_ADMIN_STATIC_TOKEN", "OE_ADMIN_ROLE_RULES"]) {
  delete process.env[v];
}

const clients = await import("../agent/control/oauth-clients.js");
const tokens = await import("../agent/control/oauth-tokens.js");
const resource = await import("../agent/control/oauth-resource.js");
const route = await import("../agent/control/oauth-route.js");
const mcp = await import("../agent/control/mcp-route.js");
const { readAudit } = await import("../agent/audit/audit.js");
const authModule = await import("../agent/control/auth.js");

const ORIGIN = "https://oe.example";
const SECRET = "a".repeat(48);
const ARMED: NodeJS.ProcessEnv = { [tokens.OAUTH_SIGNING_SECRET_ENV]: SECRET };
const DECLARED = ORIGIN;
const UNARMED: NodeJS.ProcessEnv = {};

const MACHINE_SECRET = "s3cret-machine-value-not-in-the-tree";
const MACHINE_DIGEST = createHash("sha256").update(MACHINE_SECRET, "utf-8").digest("hex");

const REGISTRY: readonly ControlOAuthClient[] = [
  {
    grant: "client_credentials",
    clientId: "deploy-bot",
    clientSecretSha256: MACHINE_DIGEST,
    scopes: [clients.SCOPE_CONTROL_ADMIN, clients.SCOPE_CONTROL_WRITE],
    label: "the deployment's own automation",
  },
  {
    grant: "client_credentials",
    clientId: "reader-bot",
    clientSecretSha256: MACHINE_DIGEST,
    scopes: [clients.SCOPE_CONTROL_ADMIN],
    label: "read-only automation — no control:write in its registration",
  },
  {
    grant: "authorization_code",
    clientId: "operator-cli",
    redirectUris: ["http://127.0.0.1:7777/callback"],
    scopes: [clients.SCOPE_CONTROL_ADMIN, clients.SCOPE_CONTROL_WRITE],
    label: "a person's CLI",
  },
];

const get = (path: string, headers: Record<string, string> = {}) => new Request(`${ORIGIN}${path}`, { headers });
const form = (path: string, body: Record<string, string>, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(body).toString(),
  });

const mcpRequest = (token: string | null, body: unknown = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) =>
  new Request(`${ORIGIN}${resource.CONTROL_MCP_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });

{
  ok(route.handleAuthorizationServerMetadata(get(route.CONTROL_OAUTH_SERVER_METADATA_PATH), { env: UNARMED, issuer: DECLARED }).status === 404, "unarmed: AS metadata 404s");
  ok(route.handleProtectedResourceMetadata(get(resource.CONTROL_PROTECTED_RESOURCE_METADATA_PATH), { env: UNARMED, issuer: DECLARED }).status === 404, "unarmed: protected-resource metadata 404s");
  ok((await route.handleAuthorize(get(`${route.CONTROL_OAUTH_AUTHORIZE_PATH}?client_id=operator-cli`), { env: UNARMED, clients: REGISTRY, issuer: DECLARED })).status === 404, "unarmed: authorize 404s");
  ok((await route.handleToken(form(route.CONTROL_OAUTH_TOKEN_PATH, { grant_type: "client_credentials" }), { env: UNARMED, issuer: DECLARED })).status === 404, "unarmed: token endpoint 404s");
  ok((await mcp.handleControlMcpRequest(get(resource.CONTROL_MCP_PATH), UNARMED, DECLARED)).status === 404, "unarmed: the MCP mount 404s (it does not disclose the seam)");

  const short: NodeJS.ProcessEnv = { [tokens.OAUTH_SIGNING_SECRET_ENV]: "short" };
  ok(tokens.oauthSigningSecret(short) === null, "a signing secret below the minimum length leaves the plane off");
  ok(route.handleAuthorizationServerMetadata(get(route.CONTROL_OAUTH_SERVER_METADATA_PATH), { env: short, issuer: DECLARED }).status === 404, "…and every route stays 404 with it");
  ok(tokens.oauthSigningSecret(ARMED) === SECRET, "a long-enough secret arms the plane");

  ok(clients.CONTROL_OAUTH_ISSUER === "", "the tracked issuer literal ships EMPTY");
  ok(resource.controlOAuthIssuer("") === null && resource.controlOAuthIssuer() === null, "…and an undeclared issuer resolves to null");
  ok(route.handleAuthorizationServerMetadata(get(route.CONTROL_OAUTH_SERVER_METADATA_PATH), { env: ARMED }).status === 404, "NEGATIVE CONTROL: armed secret + undeclared issuer ⇒ the plane is still 404");
  ok((await mcp.handleControlMcpRequest(mcpRequest(null), ARMED)).status === 404, "…including the MCP mount");
  for (const bad of ["http://oe.example", "https://oe.example/path", "not a url", "https://oe.example/"]) {
    ok(resource.controlOAuthIssuer(bad) === null, `a malformed issuer literal (${bad}) leaves the plane off, never half-armed`);
  }
  ok(resource.controlOAuthIssuer(DECLARED) === DECLARED, "a well-formed https origin is accepted");

  ok(route.handleAuthorizationServerMetadata(get(route.CONTROL_OAUTH_SERVER_METADATA_PATH), { env: ARMED, issuer: DECLARED, clients: [] }).status === 200, "secret + issuer, EMPTY registry: the discovery document publishes");
  ok((await mcp.handleControlMcpRequest(mcpRequest(null), ARMED, DECLARED)).status === 401, "…the MCP mount answers 401, not 404 — the routes exist");
  const noClient = await route.handleToken(form(route.CONTROL_OAUTH_TOKEN_PATH, { grant_type: "client_credentials", client_id: "deploy-bot", client_secret: "anything" }), { env: ARMED, issuer: DECLARED, clients: [] });
  ok(noClient.status === 401, "…and neither grant can issue a token to anybody");
}

{
  const as = (await route.handleAuthorizationServerMetadata(get(route.CONTROL_OAUTH_SERVER_METADATA_PATH), { env: ARMED, issuer: DECLARED }).json()) as Record<string, unknown>;
  ok(as["issuer"] === ORIGIN, "RFC 8414: the issuer is the deployment's own origin");
  ok(JSON.stringify(as["code_challenge_methods_supported"]) === JSON.stringify(["S256"]), "RFC 8414: S256 is the only PKCE method advertised (OAuth 2.1 removes plain)");
  ok(!("registration_endpoint" in as), "RFC 8414: no dynamic client registration is advertised — clients are tracked literals");
  ok(as["authorization_response_iss_parameter_supported"] === true, "RFC 8414: the RFC 9207 `iss` parameter is advertised, and handleAuthorize really sets it");
  ok(typeof as["service_documentation"] === "string" && !(as["service_documentation"] as string).includes(resource.CONTROL_MCP_PATH), "RFC 8414: service_documentation points at human docs, never at the protected resource");
  ok(JSON.stringify(as["grant_types_supported"]) === JSON.stringify(["authorization_code", "client_credentials"]), "RFC 8414: exactly the two implemented grants are advertised");

  const prm = (await route.handleProtectedResourceMetadata(get(resource.CONTROL_PROTECTED_RESOURCE_METADATA_PATH), { env: ARMED, issuer: DECLARED }).json()) as Record<string, unknown>;
  ok(prm["resource"] === `${ORIGIN}${resource.CONTROL_MCP_PATH}`, "RFC 9728: the resource identifier is the MCP mount's URL");
  ok(JSON.stringify(prm["authorization_servers"]) === JSON.stringify([ORIGIN]), "RFC 9728: the authorization server is this deployment");
  ok(JSON.stringify(prm["scopes_supported"]) === JSON.stringify([...resource.CONTROL_ADVERTISED_SCOPES]), "RFC 9728: the advertised scopes come off eve's own oauthResource decoration");

  ok(clients.CONTROL_OAUTH_EXTRA_AUDIENCES.length === 0, "no extra audience ships by default — the deployment's own resource is the only one accepted");
  ok(JSON.stringify(clients.controlOAuthAudiences(prm["resource"] as string, DECLARED)) === JSON.stringify([prm["resource"]]), "…so the accepted audience set is exactly the published resource");
  ok(clients.resolveAudience(null, [prm["resource"] as string]) === prm["resource"], "an absent resource parameter binds the token to the deployment's own resource");
  ok(clients.resolveAudience("https://elsewhere/mcp", [prm["resource"] as string]) === null, "NEGATIVE CONTROL: a resource this deployment does not serve is refused");
  ok(clients.controlOAuthAudiences("self", DECLARED, ["https://alias.example/control/v1/mcp"]).includes("https://alias.example/control/v1/mcp"), "a tracked extra audience widens the set, and only a pull request can add one");

  for (const forbidden of [DECLARED, `${DECLARED}/`, clients.authorizationCodeAudience(DECLARED)]) {
    ok(!clients.controlOAuthAudiences("self", DECLARED, [forbidden]).includes(forbidden), `NEGATIVE CONTROL: an extra audience of "${forbidden}" is dropped, so a code can never validate as a token`);
  }
  ok(clients.authorizationCodeAudience(DECLARED) !== DECLARED && !clients.authorizationCodeAudience(DECLARED).startsWith("https://oe.example/control"), "the code audience is namespaced away from every resource URL");
}

async function tokenFor(body: Record<string, string>): Promise<Response> {
  return route.handleToken(form(route.CONTROL_OAUTH_TOKEN_PATH, body), { env: ARMED, clients: REGISTRY, issuer: DECLARED });
}

let machineToken = "";
{
  const good = await route.handleToken(form(route.CONTROL_OAUTH_TOKEN_PATH, { grant_type: "client_credentials", client_id: "deploy-bot", client_secret: MACHINE_SECRET }), {
    env: ARMED,
    clients: REGISTRY,
    issuer: DECLARED,
  });
  ok(good.status === 200, "client_credentials with the right secret is admitted");
  const body = (await good.json()) as { access_token: string; token_type: string; expires_in: number; scope: string };
  machineToken = body.access_token;
  ok(body.token_type === "Bearer" && body.expires_in === tokens.ACCESS_TOKEN_TTL_SECONDS, "…the response is a Bearer token with the declared lifetime");
  ok(body.scope.split(" ").sort().join(" ") === [clients.SCOPE_CONTROL_ADMIN, clients.SCOPE_CONTROL_WRITE].sort().join(" "), "…and an empty ask grants the client's whole registration");
  ok(good.headers.get("cache-control") === "no-store", "…RFC 6749 §5.1: the token response is no-store");
  ok(!("refresh_token" in (body as Record<string, unknown>)), "…and no refresh token is issued (the lifetime IS the revocation window)");

  const wrongSecret = await tokenFor({ grant_type: "client_credentials", client_id: "deploy-bot", client_secret: "wrong" });
  ok(wrongSecret.status === 401, "client_credentials with a wrong secret is refused 401");
  ok(((await wrongSecret.json()) as { error: string }).error === "invalid_client", "…as invalid_client, which never says whether the id or the secret was wrong");

  const unknown = await tokenFor({ grant_type: "client_credentials", client_id: "not-registered", client_secret: MACHINE_SECRET });
  ok(unknown.status === 401 && ((await unknown.json()) as { error: string }).error === "invalid_client", "an unregistered client id is refused with the SAME error as a wrong secret");

  const basic = await route.handleToken(
    new Request(`${ORIGIN}${route.CONTROL_OAUTH_TOKEN_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${Buffer.from(`deploy-bot:${MACHINE_SECRET}`).toString("base64")}` },
      body: new URLSearchParams({ grant_type: "client_credentials" }).toString(),
    }),
    { env: ARMED, clients: REGISTRY, issuer: DECLARED },
  );
  ok(basic.status === 200, "client_secret_basic authenticates the same client");

  const overreach = await tokenFor({ grant_type: "client_credentials", client_id: "reader-bot", client_secret: MACHINE_SECRET, scope: clients.SCOPE_CONTROL_WRITE });
  ok(overreach.status === 400 && ((await overreach.json()) as { error: string }).error === "invalid_scope", "a scope outside the client's registration is REFUSED, never silently narrowed");

  const explicitResource = await tokenFor({ grant_type: "client_credentials", client_id: "deploy-bot", client_secret: MACHINE_SECRET, resource: `${ORIGIN}${resource.CONTROL_MCP_PATH}` });
  ok(explicitResource.status === 200, "an explicit RFC 8707 resource naming this deployment's own MCP mount is honoured");
  ok(!((await resource.authorizeControlMcp(mcpRequest(((await explicitResource.json()) as { access_token: string }).access_token), ARMED, DECLARED)) instanceof Response), "…and the resource server accepts the token it produced");

  const badTarget = await tokenFor({ grant_type: "client_credentials", client_id: "deploy-bot", client_secret: MACHINE_SECRET, resource: "urn:someone-else" });
  ok(badTarget.status === 400 && ((await badTarget.json()) as { error: string }).error === "invalid_target", "a resource outside the tracked audience list is refused");

  const malformedBasic = await route.handleToken(
    new Request(`${ORIGIN}${route.CONTROL_OAUTH_TOKEN_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${Buffer.from("a:%").toString("base64")}` },
      body: new URLSearchParams({ grant_type: "client_credentials" }).toString(),
    }),
    { env: ARMED, clients: REGISTRY, issuer: DECLARED },
  );
  ok(malformedBasic.status === 401, `a malformed Basic credential is refused 401, not 500 (got ${malformedBasic.status})`);

  const badGrant = await tokenFor({ grant_type: "password", client_id: "deploy-bot", client_secret: MACHINE_SECRET });
  ok(badGrant.status === 400 && ((await badGrant.json()) as { error: string }).error === "unsupported_grant_type", "a grant this server does not implement is refused by name");
}

{
  const admitted = await resource.authorizeControlMcp(mcpRequest(machineToken), ARMED, DECLARED);
  ok(!(admitted instanceof Response), "a valid token is ADMITTED by the resource server");
  if (!(admitted instanceof Response)) {
    ok(admitted.subject === "oauth-client:deploy-bot", "…the principal is the client, named for the audit row");
    ok(JSON.stringify(admitted.roles) === JSON.stringify(["admin"]), "…control:admin maps onto the EXISTING admin role, not a new one");
    ok(admitted.readOnly === false, "…control:write clears readOnly");
  }

  const readerBody = (await (await tokenFor({ grant_type: "client_credentials", client_id: "reader-bot", client_secret: MACHINE_SECRET })).json()) as { access_token: string };
  const readerPrincipal = await resource.authorizeControlMcp(mcpRequest(readerBody.access_token), ARMED, DECLARED);
  ok(!(readerPrincipal instanceof Response) && readerPrincipal.readOnly === true, "a token WITHOUT control:write is admitted read-only (the flag defaults closed)");

  const noBearer = await resource.authorizeControlMcp(mcpRequest(null), ARMED, DECLARED);
  ok(noBearer instanceof Response && noBearer.status === 401, "no bearer → 401");
  ok(noBearer instanceof Response && /Bearer/i.test(noBearer.headers.get("www-authenticate") ?? ""), "…with a real WWW-Authenticate: Bearer challenge from eve's walk");
  ok(noBearer instanceof Response && /resource_metadata="https:\/\/oe\.example\/\.well-known\/oauth-protected-resource\/control\/v1\/mcp"/.test(noBearer.headers.get("www-authenticate") ?? ""), "…carrying the RFC 9728 resource_metadata pointer");

  const garbage = await resource.authorizeControlMcp(mcpRequest("not-a-jwt"), ARMED, DECLARED);
  ok(garbage instanceof Response && garbage.status === 401, "a garbage bearer → 401");

  const expired = await tokens.mintAccessToken({
    subject: "oauth-client:deploy-bot",
    clientId: "deploy-bot",
    scopes: [clients.SCOPE_CONTROL_ADMIN],
    audience: `${ORIGIN}${resource.CONTROL_MCP_PATH}`,
    issuer: ORIGIN,
    secret: SECRET,
    now: new Date(Date.now() - 3_600_000),
  });
  const expiredRes = await resource.authorizeControlMcp(mcpRequest(expired), ARMED, DECLARED);
  ok(expiredRes instanceof Response && expiredRes.status === 401, "an EXPIRED token is refused 401");

  const wrongAud = await tokens.mintAccessToken({
    subject: "oauth-client:deploy-bot",
    clientId: "deploy-bot",
    scopes: [clients.SCOPE_CONTROL_ADMIN],
    audience: "urn:some-other-resource",
    issuer: ORIGIN,
    secret: SECRET,
  });
  ok((await resource.authorizeControlMcp(mcpRequest(wrongAud), ARMED, DECLARED)) instanceof Response, "a WRONG-AUDIENCE token is refused (RFC 8707 audience binding)");

  const spoofedHost = new Request(`https://evil.example${resource.CONTROL_MCP_PATH}`, { method: "POST", headers: { authorization: `Bearer ${machineToken}` } });
  ok(!((await resource.authorizeControlMcp(spoofedHost, ARMED, DECLARED)) instanceof Response), "a spoofed Host header does not move the issuer or the audience — the declared literal decides");
  const otherIssuerToken = await tokens.mintAccessToken({
    subject: "oauth-client:deploy-bot",
    clientId: "deploy-bot",
    scopes: [clients.SCOPE_CONTROL_ADMIN],
    audience: "https://elsewhere.example/control/v1/mcp",
    issuer: "https://elsewhere.example",
    secret: SECRET,
  });
  ok((await resource.authorizeControlMcp(mcpRequest(otherIssuerToken), ARMED, DECLARED)) instanceof Response, "a token minted under ANOTHER declared issuer is refused (the iss and aud checks)");

  const wrongKey = await tokens.mintAccessToken({
    subject: "oauth-client:deploy-bot",
    clientId: "deploy-bot",
    scopes: [clients.SCOPE_CONTROL_ADMIN],
    audience: `${ORIGIN}${resource.CONTROL_MCP_PATH}`,
    issuer: ORIGIN,
    secret: "b".repeat(48),
  });
  ok((await resource.authorizeControlMcp(mcpRequest(wrongKey), ARMED, DECLARED)) instanceof Response, "a token signed with another key is refused — rotating the secret revokes every outstanding token");

  const noRole = await tokens.mintAccessToken({
    subject: "oauth-client:deploy-bot",
    clientId: "deploy-bot",
    scopes: [clients.SCOPE_CONTROL_WRITE],
    audience: `${ORIGIN}${resource.CONTROL_MCP_PATH}`,
    issuer: ORIGIN,
    secret: SECRET,
  });
  const noRoleRes = await resource.authorizeControlMcp(mcpRequest(noRole), ARMED, DECLARED);
  ok(noRoleRes instanceof Response && noRoleRes.status === 403, "a token with NO ROLE SCOPE is refused 403 at the door, never admitted with roles: []");
  ok(noRoleRes instanceof Response && /insufficient_scope/.test(noRoleRes.headers.get("www-authenticate") ?? ""), "…with insufficient_scope, so the client knows to ask for more");
}

{
  ok(JSON.stringify(clients.scopesToGrant(["control:admin", "control:write"])) === JSON.stringify({ roles: ["admin"], readOnly: false }), "control:admin + control:write → the admin role, writable");
  ok(clients.scopesToGrant(["control:admin"]).readOnly === true, "NEGATIVE CONTROL: without control:write the grant is read-only");
  ok(JSON.stringify(clients.scopesToGrant(["control:domain:eng"]).roles) === JSON.stringify(["domain:eng"]), "control:domain:<name> → the existing domain:<name> role");
  ok(clients.scopesToGrant(["control:domain:eng"]).roles.includes("admin") === false, "NEGATIVE CONTROL: a domain scope never yields the admin role");
  ok(clients.scopesToGrant(["admin", "control:domain:", "control:bogus"]).roles.length === 0, "unknown, bare and empty-suffix scopes grant nothing");
  ok(clients.scopesToGrant([]).roles.length === 0 && clients.scopesToGrant([]).readOnly === true, "an empty scope set grants nothing and is read-only");
  ok(clients.isKnownControlScope("control:domain:eng") && !clients.isKnownControlScope("control:domain:"), "the scope grammar refuses a domain scope with no name");
}

const verifier = randomBytes(48).toString("base64url");
const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
const REDIRECT = "http://127.0.0.1:7777/callback";
const adminIdentity = async () => ({ issuer: "https://idp.example", subject: "user-1", emailVerified: true, roles: ["admin"] });
const authorizeUrl = (over: Record<string, string> = {}) => {
  const p = new URLSearchParams({
    response_type: "code",
    client_id: "operator-cli",
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "xyz",
    ...over,
  });
  return `${route.CONTROL_OAUTH_AUTHORIZE_PATH}?${p.toString()}`;
};

let code = "";
{
  const denied = await route.handleAuthorize(get(authorizeUrl()), { env: ARMED, clients: REGISTRY, issuer: DECLARED });
  ok(denied.status === 401, "authorize with NO identity is refused 401 (no identity door is configured in this process)");
  ok(/Bearer/i.test(denied.headers.get("www-authenticate") ?? ""), "…with a Bearer challenge, not a login page — the browser leg is OPE-72 (a), not built");

  const granted = await route.handleAuthorize(get(authorizeUrl()), { env: ARMED, clients: REGISTRY, issuer: DECLARED, adminIdentity });
  ok(granted.status === 302, "authorize with an admin identity redirects");
  const location = new URL(granted.headers.get("location") ?? "");
  ok(location.origin + location.pathname === REDIRECT, "…to the registered redirect URI, exactly");
  ok(location.searchParams.get("state") === "xyz", "…carrying the caller's state back");
  code = location.searchParams.get("code") ?? "";
  ok(code.length > 0, "…and an authorization code");
  ok(location.searchParams.get("iss") === DECLARED, "…and RFC 9207 `iss`, so a client behind one redirect URI knows which server answered");

  const badRedirect = await route.handleAuthorize(get(authorizeUrl({ redirect_uri: "https://evil.example/steal" })), { env: ARMED, clients: REGISTRY, issuer: DECLARED, adminIdentity });
  ok(badRedirect.status === 400 && badRedirect.headers.get("location") === null, "an unregistered redirect_uri is refused DIRECTLY — the endpoint is never an open redirector");

  const unknownClient = await route.handleAuthorize(get(authorizeUrl({ client_id: "deploy-bot" })), { env: ARMED, clients: REGISTRY, issuer: DECLARED, adminIdentity });
  ok(unknownClient.status === 400 && unknownClient.headers.get("location") === null, "a client registered for client_credentials cannot walk the person flow");

  const plain = await route.handleAuthorize(get(authorizeUrl({ code_challenge_method: "plain" })), { env: ARMED, clients: REGISTRY, issuer: DECLARED, adminIdentity });
  ok(plain.status === 302 && (new URL(plain.headers.get("location") ?? "").searchParams.get("error") ?? "") === "invalid_request", "code_challenge_method=plain is refused (OAuth 2.1 removes it)");

  const serviceIdentity = async () => ({ issuer: authModule.SERVICE_TOKEN_ISSUER, subject: "svc:e2e-harness", emailVerified: false, roles: ["admin"], readOnly: true });
  const serviceDenied = await route.handleAuthorize(get(authorizeUrl()), { env: ARMED, clients: REGISTRY, issuer: DECLARED, adminIdentity: serviceIdentity });
  ok(serviceDenied.status === 403, `NEGATIVE CONTROL: a READ service token cannot authorize a control-plane client (got ${serviceDenied.status})`);
  ok(serviceDenied.headers.get("location") === null, "…and it is refused directly, never by redirecting with a code");
  const familyRows = await readAudit({ org: "acme", action: "control.oauth_refused", limit: 50 });
  ok(familyRows.some((r) => r.principalId === "svc:e2e-harness"), "…and the refusal is audited, naming the service principal");

  const overreach = await route.handleAuthorize(get(authorizeUrl({ scope: "control:domain:eng" })), { env: ARMED, clients: REGISTRY, issuer: DECLARED, adminIdentity });
  ok((new URL(overreach.headers.get("location") ?? "").searchParams.get("error") ?? "") === "invalid_scope", "a scope outside the client's registration is refused on the person leg too");
  const scopeProbeRows = await readAudit({ org: "acme", action: "control.oauth_refused", limit: 50 });
  ok(
    scopeProbeRows.some((r) => r.principalId === "https://idp.example#user-1" && (r.detail as { reason?: string } | undefined)?.reason === "invalid_scope"),
    "…and that refusal is audited, naming the identity that probed",
  );
}

{
  const spent = new Set<string>();
  const markCodeSpent = async (_org: string, key: string) => (spent.has(key) ? false : (spent.add(key), true));
  const exchange = (over: Record<string, string> = {}, deps: Record<string, unknown> = {}) =>
    route.handleToken(form(route.CONTROL_OAUTH_TOKEN_PATH, { grant_type: "authorization_code", client_id: "operator-cli", code, redirect_uri: REDIRECT, code_verifier: verifier, ...over }), {
      env: ARMED,
      clients: REGISTRY,
      issuer: DECLARED,
      markCodeSpent,
      ...deps,
    });

  const wrongVerifier = await exchange({ code_verifier: randomBytes(48).toString("base64url") });
  ok(wrongVerifier.status === 400 && ((await wrongVerifier.json()) as { error: string }).error === "invalid_grant", "a WRONG PKCE verifier is refused — and does not burn the code");

  const wrongRedirect = await exchange({ redirect_uri: "http://127.0.0.1:7777/other" });
  ok(wrongRedirect.status === 400, "a redirect_uri that differs from the one the code was bound to is refused");

  const good = await exchange();
  ok(good.status === 200, "the PKCE round trip completes: authorize → code → token");
  const body = (await good.json()) as { access_token: string; scope: string };
  ok(body.scope.split(" ").includes(clients.SCOPE_CONTROL_ADMIN), "…the token carries the scopes the identity's roles allowed");
  const person = await resource.authorizeControlMcp(mcpRequest(body.access_token), ARMED, DECLARED);
  ok(!(person instanceof Response) && person.subject === "https://idp.example#user-1", "…and the resource server names the PERSON in the principal, not the client");

  const replay = await exchange();
  ok(replay.status === 400 && ((await replay.json()) as { error: string }).error === "invalid_grant", "REPLAYING the same code is refused — single use, claimed atomically");

  const granted = await route.handleAuthorize(get(authorizeUrl()), { env: ARMED, clients: REGISTRY, issuer: DECLARED, adminIdentity });
  const fresh = new URL(granted.headers.get("location") ?? "").searchParams.get("code") ?? "";
  const storeDown = await route.handleToken(
    form(route.CONTROL_OAUTH_TOKEN_PATH, { grant_type: "authorization_code", client_id: "operator-cli", code: fresh, redirect_uri: REDIRECT, code_verifier: verifier }),
    {
      env: ARMED,
      clients: REGISTRY,
      issuer: DECLARED,
      markCodeSpent: async () => {
        throw new Error("store down");
      },
    },
  );
  ok(storeDown.status === 400, "an UNREACHABLE single-use store refuses the exchange (fail-closed, unlike post-once.ts)");
}

{
  const admin = route.scopesAllowedForIdentity({ issuer: "i", subject: "s", emailVerified: false, roles: ["admin"] });
  ok(admin.includes(clients.SCOPE_CONTROL_ADMIN) && admin.includes(clients.SCOPE_CONTROL_WRITE), "an admin identity may receive control:admin and control:write");
  const readOnly = route.scopesAllowedForIdentity({ issuer: "i", subject: "s", emailVerified: false, roles: ["admin"], readOnly: true });
  ok(!readOnly.includes(clients.SCOPE_CONTROL_WRITE), "NEGATIVE CONTROL: a readOnly principal may never receive control:write");
  const domain = route.scopesAllowedForIdentity({ issuer: "i", subject: "s", emailVerified: false, roles: ["domain:eng"] });
  ok(domain.includes("control:domain:eng") && !domain.includes(clients.SCOPE_CONTROL_ADMIN), "NEGATIVE CONTROL: a domain-scoped identity cannot mint an admin token");
}

{
  const res = await mcp.handleControlMcpRequest(mcpRequest(machineToken, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }), ARMED, DECLARED);
  ok(res.status === 200, `the MCP mount answers a valid token's initialize (got ${res.status})`);
  const text = await res.text();
  ok(/"serverInfo"/.test(text), `…with a real MCP initialize result (got: ${text.slice(0, 200)})`);

  const refused = await mcp.handleControlMcpRequest(mcpRequest(null), ARMED, DECLARED);
  ok(refused.status === 401, "…and refuses an unauthenticated one before building any server");

  const rows = await readAudit({ org: "acme", action: "control.service_call", limit: 50 });
  ok(rows.some((r) => r.principalId === "oauth-client:deploy-bot"), "every authenticated MCP call is audited, naming the token's principal");
  const issued = await readAudit({ org: "acme", action: "control.oauth_token_issued", limit: 50 });
  ok(issued.some((r) => r.principalId === "oauth-client:deploy-bot"), "every token issue is audited, naming the principal");
  ok(issued.some((r) => r.principalId === "https://idp.example#user-1"), "…including the person leg's issue");
  const refusals = await readAudit({ org: "acme", action: "control.oauth_refused", limit: 50 });
  ok(refusals.some((r) => r.principalId === "oauth-client:deploy-bot"), "a REGISTERED client failing its secret is audited under its own id");

  const marker = `never-registered-${Date.now()}`;
  await tokenFor({ grant_type: "client_credentials", client_id: marker, client_secret: "whatever" });
  const after = await readAudit({ org: "acme", limit: 200 });
  ok(after.every((r) => !(r.principalId ?? "").includes(marker) && !JSON.stringify(r.detail ?? {}).includes(marker)), "NEGATIVE CONTROL: an UNREGISTERED client id writes no audit row at all");
  ok(
    JSON.stringify([...rows, ...issued, ...refusals]).includes(MACHINE_SECRET) === false,
    "🔴 no audit row anywhere carries the client secret value",
  );
  const call = await mcp.handleControlMcpRequest(
    mcpRequest(machineToken, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "set_spend_limit", arguments: { org: "acme", scopeKey: "acme/test", level: "surface", monthlyUsd: 5 } },
    }),
    ARMED,
    DECLARED,
  );
  const callText = await call.text();
  ok(call.status === 200 && !/"isError":true/.test(callText), `a write tool runs over the HTTPS mount (got ${call.status}: ${callText.slice(0, 240)})`);
  const writeRows = await readAudit({ org: "acme", action: "admin.spend.set_limit", limit: 20 });
  ok(writeRows.length > 0, "…and it left an audit row");
  ok(
    writeRows.every((r) => r.principalId === "oauth-client:deploy-bot"),
    `…whose principal is the token's principal VERBATIM, joining to the control.service_call row (got ${writeRows.map((r) => r.principalId).join(", ")})`,
  );

  const readerToken = (await (await tokenFor({ grant_type: "client_credentials", client_id: "reader-bot", client_secret: MACHINE_SECRET })).json()) as { access_token: string };
  const readerList = await mcp.handleControlMcpRequest(mcpRequest(readerToken.access_token, { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }), ARMED, DECLARED);
  const readerText = await readerList.text();
  ok(readerList.status === 200 && !/"set_spend_limit"/.test(readerText), "a token without control:write gets a server with NO write tools — server.ts's single choke point");
  const writerList = await mcp.handleControlMcpRequest(mcpRequest(machineToken, { jsonrpc: "2.0", id: 4, method: "tools/list", params: {} }), ARMED, DECLARED);
  ok(/"set_spend_limit"/.test(await writerList.text()), "…while a control:write token does get them (so the check above is not vacuous)");
}

{
  const here = dirname(fileURLToPath(import.meta.url));
  const evePkg = JSON.parse(readFileSync(resolve(here, "../../../node_modules/eve/package.json"), "utf-8")) as { version: string };
  ok(evePkg.version === "0.71.0", `the parity claims below are pinned to eve 0.71.0 (installed: ${evePkg.version})`);
  const eveAuth = readFileSync(resolve(here, "../../../node_modules/eve/dist/src/public/channels/auth.d.ts"), "utf-8");

  for (const symbol of ["function jwtHmac", "function oauthResource", "function routeAuth", "function readOAuthResourceOptions"]) {
    ok(eveAuth.includes(symbol), `eve ships \`${symbol.replace("function ", "")}\` — the resource-server arm is eve's, not ours`);
  }

  for (const absent of ["tokenEndpoint", "authorizationServer(", "clientCredentials", "authorizationCode", "pkce", "codeChallenge"]) {
    ok(!eveAuth.includes(absent), `eve ships no \`${absent}\` — the authorization-server half is genuinely ours`);
  }

  const eveMcp = readFileSync(resolve(here, "../../../node_modules/eve/dist/src/public/channels/mcp.js"), "utf-8");
  ok(eveMcp.includes("#internal/mcp/protected-resource.js"), "eve builds the RFC 9728 document from an INTERNAL module…");
  ok(!eveAuth.includes("ProtectedResourceMetadata"), "…which `eve/channels/auth` does not re-export, so the control mount publishes its own");
  const evePkgJson = readFileSync(resolve(here, "../../../node_modules/eve/package.json"), "utf-8");
  ok(!evePkgJson.includes('"./internal/mcp'), "…and no package export makes that internal module reachable");

  const auth = resource.controlResourceAuth(ARMED, DECLARED);
  ok(auth !== null, "the resource AuthFn is built when the plane is armed");
  const { readOAuthResourceOptions } = await import("eve/channels/auth");
  const options = auth === null ? undefined : readOAuthResourceOptions(auth);
  ok(options?.issuer === ORIGIN && options?.resource === `${ORIGIN}${resource.CONTROL_MCP_PATH}`, "eve reads our oauthResource decoration back — the published document cannot drift from the door");
}

{
  ok(clients.CONTROL_OAUTH_CLIENTS.length === 0, "the tracked client registry ships EMPTY — arming the secret alone opens nothing");
  ok(clients.findControlOAuthClient("deploy-bot") === null, "…so the default lookup finds nobody");
  ok(clients.findControlOAuthClient("deploy-bot", REGISTRY) !== null, "…while a registered client resolves");
  ok(clients.findControlOAuthClient("deploy-bot", [{ ...REGISTRY[0], clientSecretSha256: "nothex" } as ControlOAuthClient]) === null, "a registration with a malformed digest authenticates nobody");
  ok(
    clients.findControlOAuthClient("operator-cli", [{ ...REGISTRY[2], redirectUris: ["http://evil.example/cb"] } as ControlOAuthClient]) === null,
    "a plain-http redirect URI outside localhost is refused at lookup",
  );

  const { CONTRIBUTIONS } = await import("../agent/contributions.js");
  ok(
    CONTRIBUTIONS.contributions.some((c) => c.kind === "channel" && c.name === "control-mcp" && c.module === "agent/channels/control-mcp.js"),
    "the channel is declared in contributions.ts, so `oe build` mounts it on a deployment",
  );

  const channel = (await import("../agent/channels/control-mcp.js")).default;
  const paths = channel.routes.map((r) => r.path);
  for (const p of [resource.CONTROL_MCP_PATH, route.CONTROL_OAUTH_TOKEN_PATH, route.CONTROL_OAUTH_AUTHORIZE_PATH, route.CONTROL_OAUTH_SERVER_METADATA_PATH, resource.CONTROL_PROTECTED_RESOURCE_METADATA_PATH]) {
    ok(paths.includes(p), `the deployment mount serves ${p}`);
  }
}

await removeTempDir(dir);
console.log(`✓ control OAuth plane: ${passed} assertions passed (fail-closed 404 / client_credentials / PKCE round trip + replay / expired-audience-issuer-signature-scope refusals / audited / eve-parity pinned)`);
