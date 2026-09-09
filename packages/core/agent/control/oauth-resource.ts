import { jwtHmac, oauthResource, readOAuthResourceOptions, routeAuth, type AuthFn } from "eve/channels/auth";
import {
  CONTROL_OAUTH_ISSUER,
  controlOAuthAudiences,
  isValidIssuer,
  SCOPE_CONTROL_ADMIN,
  SCOPE_CONTROL_WRITE,
  parseScopeString,
  scopesToGrant,
  type ControlGrant,
} from "./oauth-clients.js";
import { oauthSigningSecret } from "./oauth-tokens.js";

export const CONTROL_MCP_PATH = "/control/v1/mcp";
export const CONTROL_PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource/control/v1/mcp";

export const CONTROL_ADVERTISED_SCOPES: readonly string[] = [SCOPE_CONTROL_ADMIN, SCOPE_CONTROL_WRITE];

export function controlOAuthIssuer(issuer: string = CONTROL_OAUTH_ISSUER): string | null {
  return isValidIssuer(issuer) ? issuer : null;
}

export function controlMcpResource(issuer: string): string {
  return new URL(CONTROL_MCP_PATH, issuer).toString();
}

export function controlResourceAuth(env: NodeJS.ProcessEnv = process.env, declaredIssuer: string = CONTROL_OAUTH_ISSUER): AuthFn<Request> | null {
  const secret = oauthSigningSecret(env);
  if (secret === null) return null;
  const issuer = controlOAuthIssuer(declaredIssuer);
  if (issuer === null) return null;
  const resource = controlMcpResource(issuer);
  return oauthResource(
    jwtHmac({
      algorithm: "HS256",
      audiences: controlOAuthAudiences(resource, issuer),
      issuer,
      secret,
      clockSkewSeconds: 30,
    }),
    { issuer, resource, scopes: CONTROL_ADVERTISED_SCOPES },
  );
}

export interface ControlOAuthPrincipal extends ControlGrant {
  readonly subject: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
}

export async function authorizeControlMcp(
  req: Request,
  env: NodeJS.ProcessEnv = process.env,
  declaredIssuer: string = CONTROL_OAUTH_ISSUER,
): Promise<ControlOAuthPrincipal | Response> {
  const auth = controlResourceAuth(env, declaredIssuer);
  const issuer = controlOAuthIssuer(declaredIssuer);
  if (auth === null || issuer === null) return new Response("not found", { status: 404 });
  const verified = await routeAuth(req, auth);
  if (verified instanceof Response) return withResourceMetadata(verified, issuer);

  const scopes = parseScopeString(readAttribute(verified.attributes, "scope"));
  const grant = scopesToGrant(scopes);
  if (grant.roles.length === 0) {
    return withResourceMetadata(
      new Response(JSON.stringify({ ok: false, code: "insufficient_scope", error: "the token carries no control-plane role scope" }), {
        status: 403,
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
          "www-authenticate": `Bearer error="insufficient_scope", scope="${CONTROL_ADVERTISED_SCOPES.join(" ")}"`,
        },
      }),
      issuer,
    );
  }
  return {
    ...grant,
    scopes,
    subject: verified.subject ?? verified.principalId,
    clientId: readAttribute(verified.attributes, "client_id") ?? "unknown",
  };
}

function readAttribute(attributes: Readonly<Record<string, string | readonly string[]>>, name: string): string | undefined {
  const value = attributes[name];
  return typeof value === "string" ? value : undefined;
}

function withResourceMetadata(res: Response, issuer: string): Response {
  if (res.status !== 401 && res.status !== 403) return res;
  const metadata = new URL(CONTROL_PROTECTED_RESOURCE_METADATA_PATH, issuer).toString();
  const headers = new Headers(res.headers);
  const existing = headers.get("www-authenticate");
  if (existing === null) headers.set("www-authenticate", `Bearer resource_metadata="${metadata}"`);
  else if (!/(?:^|[\s,])resource_metadata\s*=/i.test(existing)) {
    headers.set("www-authenticate", `${existing}${existing.trim().toLowerCase() === "bearer" ? " " : ", "}resource_metadata="${metadata}"`);
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export function controlProtectedResourceMetadata(
  env: NodeJS.ProcessEnv = process.env,
  declaredIssuer: string = CONTROL_OAUTH_ISSUER,
): Record<string, unknown> | null {
  const auth = controlResourceAuth(env, declaredIssuer);
  const issuer = controlOAuthIssuer(declaredIssuer);
  if (auth === null || issuer === null) return null;
  const options = readOAuthResourceOptions(auth);
  if (options === undefined) return null;
  const authorizationServers = options.issuer === undefined ? [...(options.authorizationServers ?? [])] : [options.issuer];
  return {
    resource: options.resource ?? controlMcpResource(issuer),
    authorization_servers: authorizationServers,
    scopes_supported: [...(options.scopes ?? [])],
    bearer_methods_supported: ["header"],
  };
}
