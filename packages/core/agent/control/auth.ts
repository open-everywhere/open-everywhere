import { jwtVerify, createRemoteJWKSet, type JWTVerifyGetKey } from "jose";
import type { IncomingMessage } from "node:http";
import { domainForChannel, memoryRefs, type Domain } from "../memory/domain.js";
import { getConfig } from "../access/config.js";

export interface AdminIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly email?: string;
  readonly emailVerified: boolean;
  readonly roles: readonly string[];
}

export interface RawIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly email?: string;
  readonly emailVerified: boolean;
}

export type TokenVerifier = (token: string, req: IncomingMessage) => Promise<RawIdentity | null>;

export interface RoleRule {
  readonly roles: readonly string[];
  readonly issuer?: string;
  readonly subject?: string;
  readonly email?: string;
  readonly emailDomain?: string;
}

export function resolveRoles(id: RawIdentity, rules: readonly RoleRule[]): string[] {
  const granted = new Set<string>();
  for (const rule of rules) {
    if (rule.issuer !== undefined && rule.issuer !== id.issuer) continue;
    if (rule.subject !== undefined && rule.subject !== id.subject) continue;
    if (rule.email !== undefined) {
      if (!id.emailVerified || id.email?.toLowerCase() !== rule.email.toLowerCase()) continue;
    }
    if (rule.emailDomain !== undefined) {
      const domain = id.email?.split("@")[1]?.toLowerCase();
      if (!id.emailVerified || domain !== rule.emailDomain.toLowerCase()) continue;
    }
    if (rule.issuer === undefined && rule.subject === undefined && rule.email === undefined && rule.emailDomain === undefined) {
      continue;
    }
    for (const r of rule.roles) granted.add(r);
  }
  return [...granted];
}

export interface ScopeRequest {
  readonly org: string;
  readonly surfaceKey?: string;
  readonly domain?: string;
}

export function roleCoversScope(roles: readonly string[], scope: ScopeRequest, domains: readonly Domain[]): boolean {
  if (roles.includes("admin")) return true;
  const domainRoles = new Set(roles.filter((r) => r.startsWith("domain:")).map((r) => r.slice("domain:".length)));
  if (domainRoles.size === 0) return false;
  const resolved = scope.domain ?? (scope.surfaceKey ? domainForChannel(scope.surfaceKey, domains)?.name : undefined);
  return resolved !== undefined && domainRoles.has(resolved);
}

export function scopeDenial(roles: readonly string[], scope: ScopeRequest): string | null {
  if (roles.includes("admin")) return null;
  if (roleCoversScope(roles, scope, getConfig().loadDomains())) return null;
  const label = scope.surfaceKey ?? scope.domain ?? `org "${scope.org}" (org-wide)`;
  return `forbidden: no role covers ${label} (have: ${roles.length ? roles.join(", ") : "none"}; need "admin" or a covering "domain:<name>").`;
}

export function siloCoveringDomains(siloName: string, domains: readonly Domain[]): string[] {
  return domains.filter((d) => d.channels !== undefined && memoryRefs(d).includes(siloName)).map((d) => d.name);
}

export function siloScopeDenial(roles: readonly string[], org: string, siloName: string, domains: readonly Domain[]): string | null {
  if (roles.includes("admin")) return null;
  const covering = siloCoveringDomains(siloName, domains);
  const domainRoles = new Set(roles.filter((r) => r.startsWith("domain:")).map((r) => r.slice("domain:".length)));
  if (covering.some((d) => domainRoles.has(d))) return null;
  return `forbidden: no role covers memory silo "${siloName}" in org "${org}" (have: ${roles.length ? roles.join(", ") : "none"}; need "admin" or a covering "domain:<name>").`;
}

function bearer(req: IncomingMessage): string | null {
  const h = req.headers["authorization"];
  if (typeof h !== "string") return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1] : null;
}

export function genericOidcVerifier(opts: {
  issuer: string;
  audience: string;
  jwks?: JWTVerifyGetKey;
  jwksUri?: string;
}): TokenVerifier {
  const keySet =
    opts.jwks ??
    createRemoteJWKSet(new URL(opts.jwksUri ?? `${opts.issuer.replace(/\/$/, "")}/.well-known/jwks.json`));
  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, keySet, { issuer: opts.issuer, audience: opts.audience });
      if (!payload.sub) return null;
      return {
        issuer: opts.issuer,
        subject: payload.sub,
        email: typeof payload.email === "string" ? payload.email : undefined,
        emailVerified: payload.email_verified === true,
      };
    } catch {
      return null;
    }
  };
}

export function githubOAuthVerifier(opts?: {
  fetchUser?: (token: string) => Promise<{ id: number | string; login: string; email?: string; emailVerified?: boolean } | null>;
}): TokenVerifier {
  const fetchUser =
    opts?.fetchUser ??
    (async (token: string) => {
      const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "open-everywhere" };
      const u = await fetch("https://api.github.com/user", { headers });
      if (!u.ok) return null;
      const user = (await u.json()) as { id: number; login: string };
      let email: string | undefined;
      let emailVerified = false;
      const e = await fetch("https://api.github.com/user/emails", { headers });
      if (e.ok) {
        const emails = (await e.json()) as { email: string; primary: boolean; verified: boolean }[];
        const primary = emails.find((x) => x.primary) ?? emails.find((x) => x.verified);
        if (primary) {
          email = primary.email;
          emailVerified = primary.verified;
        }
      }
      return { id: user.id, login: user.login, email, emailVerified };
    });
  return async (token) => {
    const user = await fetchUser(token).catch(() => null);
    if (!user) return null;
    return {
      issuer: "https://github.com",
      subject: `github:${user.id}`,
      email: user.email,
      emailVerified: user.emailVerified === true,
    };
  };
}

export function staticTokenVerifier(opts: { token: string; subject?: string }): TokenVerifier {
  return async (token) => {
    if (!opts.token || token !== opts.token) return null;
    return { issuer: "static", subject: opts.subject ?? "local-admin", emailVerified: false };
  };
}

export function makeAdminAuthenticator(
  verifiers: readonly TokenVerifier[],
  rules: readonly RoleRule[],
): (req: IncomingMessage) => Promise<AdminIdentity | null> {
  return async (req) => {
    const token = bearer(req);
    if (!token) return null;
    for (const verify of verifiers) {
      const raw = await verify(token, req).catch(() => null);
      if (!raw) continue;
      const roles = resolveRoles(raw, rules);
      if (roles.length === 0) return null;
      return { ...raw, roles };
    }
    return null;
  };
}

export function adminAuthenticatorFromEnv(): ((req: IncomingMessage) => Promise<AdminIdentity | null>) | null {
  const verifiers: TokenVerifier[] = [];
  const rules: RoleRule[] = [];

  const issuer = process.env.OE_ADMIN_OIDC_ISSUER;
  const audience = process.env.OE_ADMIN_OIDC_AUDIENCE;
  if (issuer && audience) verifiers.push(genericOidcVerifier({ issuer, audience }));

  if (process.env.OE_ADMIN_GITHUB === "1") verifiers.push(githubOAuthVerifier());

  const staticToken = process.env.OE_ADMIN_STATIC_TOKEN;
  if (staticToken) {
    verifiers.push(staticTokenVerifier({ token: staticToken }));
    rules.push({ roles: ["admin"], issuer: "static" });
  }

  if (process.env.OE_ADMIN_ROLE_RULES) {
    try {
      const parsed = JSON.parse(process.env.OE_ADMIN_ROLE_RULES) as RoleRule[];
      if (Array.isArray(parsed)) rules.push(...parsed);
    } catch {
      throw new Error("OE_ADMIN_ROLE_RULES is not valid JSON (expected a RoleRule[] array)");
    }
  }

  if (verifiers.length === 0) return null;
  return makeAdminAuthenticator(verifiers, rules);
}
