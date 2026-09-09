import { createHash, timingSafeEqual } from "node:crypto";

export const CONTROL_OAUTH_EXTRA_AUDIENCES: readonly string[] = [];

export function controlOAuthAudiences(
  selfResource: string,
  issuer: string,
  extras: readonly string[] = CONTROL_OAUTH_EXTRA_AUDIENCES,
): string[] {
  const forbidden = new Set([issuer, `${issuer}/`, authorizationCodeAudience(issuer)]);
  const accepted = extras.filter((a) => {
    if (!forbidden.has(a)) return true;
    console.warn(
      `[open-everywhere:control] CONTROL_OAUTH_EXTRA_AUDIENCES entry ignored — an audience equal to the issuer (or to the authorization-code audience) would let a raw authorization code validate as an access token.`,
    );
    return false;
  });
  return [selfResource, ...accepted];
}

export function authorizationCodeAudience(issuer: string): string {
  return `${issuer}#authorization-code`;
}

export const CONTROL_OAUTH_ISSUER = "";

export function isValidIssuer(issuer: string): boolean {
  try {
    const url = new URL(issuer);
    return url.protocol === "https:" && url.pathname === "/" && url.search === "" && url.hash === "" && issuer === url.origin;
  } catch {
    return false;
  }
}

export const SCOPE_CONTROL_WRITE = "control:write";
export const SCOPE_CONTROL_ADMIN = "control:admin";
export const SCOPE_CONTROL_DOMAIN_PREFIX = "control:domain:";

export interface ControlGrant {
  readonly roles: readonly string[];
  readonly readOnly: boolean;
}

export function isKnownControlScope(scope: string): boolean {
  if (scope === SCOPE_CONTROL_WRITE || scope === SCOPE_CONTROL_ADMIN) return true;
  return scope.startsWith(SCOPE_CONTROL_DOMAIN_PREFIX) && scope.length > SCOPE_CONTROL_DOMAIN_PREFIX.length;
}

export function scopesToGrant(scopes: readonly string[]): ControlGrant {
  const roles = new Set<string>();
  let write = false;
  for (const scope of scopes) {
    if (scope === SCOPE_CONTROL_WRITE) {
      write = true;
      continue;
    }
    if (scope === SCOPE_CONTROL_ADMIN) {
      roles.add("admin");
      continue;
    }
    if (scope.startsWith(SCOPE_CONTROL_DOMAIN_PREFIX)) {
      const name = scope.slice(SCOPE_CONTROL_DOMAIN_PREFIX.length);
      if (name.length > 0) roles.add(`domain:${name}`);
    }
  }
  return { roles: [...roles], readOnly: !write };
}

export function parseScopeString(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw.split(/\s+/).filter((s) => s.length > 0);
}

export type ControlOAuthClient =
  | {
      readonly grant: "client_credentials";
      readonly clientId: string;
      readonly clientSecretSha256: string;
      readonly scopes: readonly string[];
      readonly label: string;
    }
  | {
      readonly grant: "authorization_code";
      readonly clientId: string;
      readonly redirectUris: readonly string[];
      readonly scopes: readonly string[];
      readonly label: string;
    };

export const CONTROL_OAUTH_CLIENTS: readonly ControlOAuthClient[] = [];

const CLIENT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export function findControlOAuthClient(
  clientId: string,
  registry: readonly ControlOAuthClient[] = CONTROL_OAUTH_CLIENTS,
): ControlOAuthClient | null {
  const client = registry.find((c) => c.clientId === clientId);
  if (!client || !CLIENT_ID.test(client.clientId)) return null;
  if (client.scopes.length === 0 || !client.scopes.every(isKnownControlScope)) return null;
  if (client.grant === "client_credentials") {
    return SHA256_HEX.test(client.clientSecretSha256) ? client : null;
  }
  if (client.redirectUris.length === 0) return null;
  return client.redirectUris.every(isAbsoluteRedirectUri) ? client : null;
}

function isAbsoluteRedirectUri(uri: string): boolean {
  try {
    const parsed = new URL(uri);
    return parsed.hash === "" && (parsed.protocol === "https:" || parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

export function clientSecretMatches(presented: string, client: ControlOAuthClient): boolean {
  if (client.grant !== "client_credentials" || !presented) return false;
  const expected = Buffer.from(client.clientSecretSha256, "hex");
  const actual = createHash("sha256").update(presented, "utf-8").digest();
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}

export function grantedScopes(requested: readonly string[], client: ControlOAuthClient): string[] | null {
  if (requested.length === 0) return [...client.scopes];
  return requested.every((s) => client.scopes.includes(s)) ? [...requested] : null;
}

export function resolveAudience(resource: string | null | undefined, allowed: readonly string[]): string | null {
  if (!resource) return allowed[0] ?? null;
  return allowed.includes(resource) ? resource : null;
}
