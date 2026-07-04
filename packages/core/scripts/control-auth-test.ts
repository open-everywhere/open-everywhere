
import assert from "node:assert/strict";
import { AddressInfo } from "node:net";
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet } from "jose";
import {
  genericOidcVerifier,
  githubOAuthVerifier,
  staticTokenVerifier,
  resolveRoles,
  makeAdminAuthenticator,
  roleCoversScope,
  scopeDenial,
  type RoleRule,
} from "../agent/control/auth.js";
import { createAdminHttpServer } from "../agent/control/http.js";
import { registerConfig } from "../agent/access/config.js";
import { defineDomain, type Domain } from "../agent/memory/domain.js";

let n = 0;
const ok = (label: string, cond: boolean) => {
  assert.ok(cond, label);
  n++;
};

const ISSUER = "https://accounts.example.com";
const AUDIENCE = "open-everywhere-control";
const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
const jwks = createLocalJWKSet({ keys: [jwk] });

async function token(claims: Record<string, unknown>, over: { aud?: string; iss?: string; expSecondsFromNow?: number } = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuedAt(now)
    .setIssuer(over.iss ?? ISSUER)
    .setAudience(over.aud ?? AUDIENCE)
    .setExpirationTime(now + (over.expSecondsFromNow ?? 3600))
    .sign(privateKey);
}

const reqWith = (tok?: string) => ({ headers: tok ? { authorization: `Bearer ${tok}` } : {} }) as never;

const oidc = genericOidcVerifier({ issuer: ISSUER, audience: AUDIENCE, jwks });

{
  const raw = await oidc(await token({ sub: "g-123", email: "rowan@x.com", email_verified: true }), reqWith());
  ok("valid OIDC token yields (issuer, subject)", raw?.issuer === ISSUER && raw?.subject === "g-123");
  ok("verified email is surfaced", raw?.email === "rowan@x.com" && raw?.emailVerified === true);
}

ok("wrong audience is rejected", (await oidc(await token({ sub: "g-1" }, { aud: "someone-else" }), reqWith())) === null);
ok("wrong issuer is rejected", (await oidc(await token({ sub: "g-1" }, { iss: "https://evil.example" }), reqWith())) === null);
ok("expired token is rejected", (await oidc(await token({ sub: "g-1" }, { expSecondsFromNow: -3600 }), reqWith())) === null);
{
  const t = await token({ sub: "g-1", email: "x@y.com", email_verified: true });
  ok("tampered token is rejected", (await oidc(t.slice(0, -3) + "AAA", reqWith())) === null);
  const unverified = await oidc(await token({ sub: "g-2", email: "rowan@x.com", email_verified: false }), reqWith());
  ok("token with email_verified:false yields emailVerified=false", unverified?.emailVerified === false);
}

{
  const rules: RoleRule[] = [
    { roles: ["admin"], email: "rowan@x.com" },
    { roles: ["viewer"], emailDomain: "x.com" },
    { roles: ["ops"], issuer: ISSUER, subject: "g-exact" },
  ];
  ok("verified email matches its rule", resolveRoles({ issuer: ISSUER, subject: "g-1", email: "rowan@x.com", emailVerified: true }, rules).includes("admin"));
  ok("UNVERIFIED email never matches an email rule (the guardrail)", !resolveRoles({ issuer: ISSUER, subject: "g-1", email: "rowan@x.com", emailVerified: false }, rules).includes("admin"));
  ok("verified domain rule matches", resolveRoles({ issuer: ISSUER, subject: "g-1", email: "a@x.com", emailVerified: true }, rules).includes("viewer"));
  ok("unverified domain never matches", resolveRoles({ issuer: ISSUER, subject: "g-1", email: "a@x.com", emailVerified: false }, rules).length === 0);
  ok("(issuer,subject) rule matches only the exact identity", resolveRoles({ issuer: ISSUER, subject: "g-exact", emailVerified: false }, rules).includes("ops"));
  ok("a different subject doesn't get the (issuer,subject) grant", !resolveRoles({ issuer: ISSUER, subject: "g-other", emailVerified: false }, rules).includes("ops"));
  ok("a rule with NO matchers grants nothing (never grant-to-all)", resolveRoles({ issuer: "z", subject: "z", emailVerified: false }, [{ roles: ["admin"] }]).length === 0);
}

{
  const rules: RoleRule[] = [{ roles: ["admin"], email: "rowan@x.com" }];
  const githubVerify = githubOAuthVerifier({ fetchUser: async () => ({ id: 42, login: "rowan", email: "rowan@x.com", emailVerified: true }) });
  const auth = makeAdminAuthenticator([oidc, githubVerify], rules);

  const viaGoogle = await auth(reqWith(await token({ sub: "g-123", email: "rowan@x.com", email_verified: true })));
  const viaGithub = await auth(reqWith("gho_faketoken"));
  ok("Google login resolves to admin", viaGoogle?.roles.includes("admin") === true && viaGoogle?.issuer === ISSUER);
  ok("GitHub login (same verified email) resolves to the SAME access", viaGithub?.roles.includes("admin") === true && viaGithub?.issuer === "https://github.com");
  ok("…but they remain DISTINCT identities (issuer,subject), not a merged account", viaGoogle?.subject !== viaGithub?.subject);

  const attacker = await auth(reqWith(await token({ sub: "evil", email: "rowan@x.com", email_verified: false })));
  ok("unverified-email impersonation attempt is denied (no roles → null)", attacker === null);
}

{
  const auth = makeAdminAuthenticator([staticTokenVerifier({ token: "s3cret" })], [{ roles: ["admin"], issuer: "static" }]);
  ok("correct static token → admin", (await auth(reqWith("s3cret")))?.roles.includes("admin") === true);
  ok("wrong static token → denied", (await auth(reqWith("nope"))) === null);
  ok("missing bearer → denied", (await auth(reqWith())) === null);
}

{
  async function listen(server: import("node:http").Server): Promise<string> {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  }
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer t" };

  const viewerOnly = createAdminHttpServer({ authenticate: async () => ({ issuer: "t", subject: "s", emailVerified: false, roles: ["viewer"] }), requiredRole: "admin" });
  const u1 = await listen(viewerOnly);
  ok("a viewer is forbidden (403) from an admin-required endpoint", (await fetch(u1, { method: "POST", headers, body })).status === 403);
  viewerOnly.close();

  const viewerOk = createAdminHttpServer({ authenticate: async () => ({ issuer: "t", subject: "s", emailVerified: false, roles: ["viewer"] }), requiredRole: "viewer" });
  const u2 = await listen(viewerOk);
  const res = await fetch(u2, { method: "POST", headers, body });
  ok("a viewer passes a viewer-required endpoint (auth gate cleared)", res.status !== 401 && res.status !== 403);
  viewerOk.close();

  const noToken = createAdminHttpServer({ authenticate: async () => null });
  const u3 = await listen(noToken);
  ok("an unresolved identity is refused (401)", (await fetch(u3, { method: "POST", headers, body })).status === 401);
  noToken.close();
}

{
  const domains: Domain[] = [
    defineDomain({ name: "org", match: "org", memory: "org-brain" }),
    defineDomain({ name: "txn", channels: ["slack/T1/C_TXN"] }),
  ];
  ok("\"admin\" covers any scope, incl. an unscoped org-wide ask", roleCoversScope(["admin"], { org: "default" }, domains));
  ok(
    "domain:<name> covers its own surfaceKey",
    roleCoversScope(["domain:txn"], { org: "default", surfaceKey: "slack/T1/C_TXN" }, domains),
  );
  ok(
    "domain:<name> covers naming the domain directly (no surfaceKey)",
    roleCoversScope(["domain:txn"], { org: "default", domain: "txn" }, domains),
  );
  ok(
    "domain:<name> does NOT cover a different domain's surfaceKey",
    !roleCoversScope(["domain:txn"], { org: "default", surfaceKey: "slack/T1/C_OTHER" }, domains),
  );
  ok(
    "FAIL-CLOSED: domain:<name> does not cover an unscoped org-wide ask (no surfaceKey/domain)",
    !roleCoversScope(["domain:txn"], { org: "default" }, domains),
  );
  ok("FAIL-CLOSED: no roles at all covers nothing", !roleCoversScope([], { org: "default", surfaceKey: "slack/T1/C_TXN" }, domains));
  ok(
    "FAIL-CLOSED: an unresolvable surfaceKey (no matching domain) is covered by nothing",
    !roleCoversScope(["domain:txn"], { org: "default", surfaceKey: "slack/T1/C_NOWHERE" }, domains),
  );

  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => domains,
    loadSilos: () => [],
    domainsForSurface: () => [],
  });
  ok("scopeDenial: admin -> null (covered)", scopeDenial(["admin"], { org: "default", surfaceKey: "slack/T1/C_TXN" }) === null);
  ok(
    "scopeDenial: covering domain role -> null (covered)",
    scopeDenial(["domain:txn"], { org: "default", surfaceKey: "slack/T1/C_TXN" }) === null,
  );
  const denial = scopeDenial(["domain:txn"], { org: "default", surfaceKey: "slack/T1/C_OTHER" });
  ok("scopeDenial: non-covering domain role -> a denial message naming the scope", typeof denial === "string" && /C_OTHER/.test(denial));
}

console.log(`\n✓ control auth: ${n} assertions passed (OIDC verify, identity model, verified-email linking + guardrails, RBAC)\n`);
