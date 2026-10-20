// proves: control.service_call

import assert from "node:assert/strict";
import { AddressInfo } from "node:net";
import { routeAuth } from "eve/channels/auth";
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet } from "jose";
import { createHash } from "node:crypto";
import {
  genericOidcVerifier,
  githubOAuthVerifier,
  staticTokenVerifier,
  resolveRoles,
  makeAdminAuthenticator,
  parseServiceTokenEntries,
  makeServiceTokenAuthenticator,
  verifyServiceToken,
  resolveAdminAuthenticator,
  serviceTokenAuth,
  injectTokenAuth,
  SERVICE_TOKEN_ISSUER,
  SERVICE_TOKEN_AUTHENTICATOR,
  INJECT_TOKEN_AUTHENTICATOR,
  roleCoversScope,
  scopeDenial,
  siloScopeDenial,
  foreignOrgDenial,
  type RoleRule,
} from "../agent/control/auth.js";
import { createAdminHttpServer } from "../agent/control/http.js";
import { defineSettings, overrideSettingsForTest, resetSettingsForTest } from "../agent/settings/settings.js";
import { CONTROL_TOOL_NAMES } from "../agent/control/server.js";
import { CONTROL_WRITE_TOOL_NAMES } from "../agent/control/writes.js";
import { readAudit } from "../agent/audit/audit.js";
import { registerConfig } from "../agent/access/config.js";
import { defineDomain, type Domain } from "../agent/memory/domain.js";
import { _setDeploymentIdentityForTest, deploymentOrg } from "../agent/identity/deployment-identity.js";
import { FIRE_UNATTENDED_ATTR } from "../agent/identity/binding.js";
import { TOKEN_FAMILY_ATTR } from "../agent/routines/fire-auth.js";

import { pinSuiteStore } from "./_suite-store.js";
pinSuiteStore("control-auth");

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
  const [head, body, sig] = t.split(".");
  const sigBytes = Buffer.from(sig, "base64url");
  sigBytes[sigBytes.length >> 1] ^= 0x01;
  const tampered = `${head}.${body}.${sigBytes.toString("base64url")}`;
  ok("the tamper changes the signature bytes", !sigBytes.equals(Buffer.from(sig, "base64url")) && tampered !== t);
  ok("the tamper keeps header + claims, so only the signature can reject it", tampered.startsWith(`${head}.${body}.`));
  ok("tampered token is rejected", (await oidc(tampered, reqWith())) === null);
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
    defineDomain({ name: "txn", reach: ["slack/T1/C_TXN"] }),
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
  _setDeploymentIdentityForTest({ org: "default" });
  ok("scopeDenial: admin -> null (covered)", scopeDenial(["admin"], { org: "default", surfaceKey: "slack/T1/C_TXN" }) === null);
  ok(
    "scopeDenial: covering domain role -> null (covered)",
    scopeDenial(["domain:txn"], { org: "default", surfaceKey: "slack/T1/C_TXN" }) === null,
  );
  const denial = scopeDenial(["domain:txn"], { org: "default", surfaceKey: "slack/T1/C_OTHER" });
  ok("scopeDenial: non-covering domain role -> a denial message naming the scope", typeof denial === "string" && /C_OTHER/.test(denial));

  const foreignAdmin = scopeDenial(["admin"], { org: "other-tenant", surfaceKey: "slack/T1/C_TXN" });
  ok(
    "🔴 scopeDenial: ADMIN naming a foreign org -> DENIED (the role no longer short-circuits past the org)",
    typeof foreignAdmin === "string" && /other-tenant/.test(foreignAdmin) && /default/.test(foreignAdmin),
  );
  ok(
    "🔴 scopeDenial: a foreign org is denied for an UNSCOPED ask too — the org-wide reads (usage_window, overrides_list) are the sharp case",
    typeof scopeDenial(["admin"], { org: "other-tenant" }) === "string",
  );
  ok(
    "scopeDenial: a covering domain role does not carry across the org line either",
    typeof scopeDenial(["domain:txn"], { org: "other-tenant", surfaceKey: "slack/T1/C_TXN" }) === "string",
  );
  ok(
    "🔴 POSITIVE CONTROL: the same admin, the same scope, THIS deployment's org -> null (the gate refuses the org, not every call)",
    scopeDenial(["admin"], { org: "default", surfaceKey: "slack/T1/C_TXN" }) === null,
  );

  ok(
    "🔴 siloScopeDenial: ADMIN naming a foreign org -> DENIED",
    typeof siloScopeDenial(["admin"], "other-tenant", "txn-brain", domains) === "string",
  );
  ok(
    "🔴 POSITIVE CONTROL: the same admin on THIS deployment's org -> null",
    siloScopeDenial(["admin"], "default", "txn-brain", domains) === null,
  );

  ok("foreignOrgDenial: this deployment's own org -> null", foreignOrgDenial("default") === null);
  ok("foreignOrgDenial: any other org -> a message naming both", (foreignOrgDenial("other-tenant") ?? "").includes('"default"'));
}

{
  const H = "a".repeat(64);
  ok("service tokens: unset env -> no entries (mode fully off)", parseServiceTokenEntries(undefined).length === 0);
  ok("service tokens: blank env -> no entries", parseServiceTokenEntries("   ").length === 0);
  ok("service tokens: an entry with no colon is dropped", parseServiceTokenEntries(`nocolonhere${H}`).length === 0);
  ok("service tokens: a short/bad hash is dropped", parseServiceTokenEntries("ci:abc123").length === 0);
  ok("service tokens: a non-hex hash is dropped", parseServiceTokenEntries(`ci:${"z".repeat(64)}`).length === 0);
  ok("service tokens: an UPPERCASE name is dropped (names are lowercase-canonical)", parseServiceTokenEntries(`CI:${H}`).length === 0);
  ok("service tokens: an empty name is dropped", parseServiceTokenEntries(`:${H}`).length === 0);
  const upper = parseServiceTokenEntries(`ci:${"A".repeat(64)}`);
  ok("service tokens: uppercase HASH hex is tolerated (normalised down)", upper.length === 1 && upper[0].sha256 === H);
  const mixed = parseServiceTokenEntries(` e2e-harness:${H} , bad-entry , ci_2:${"b".repeat(64)} `);
  ok("service tokens: valid entries survive a malformed sibling (dropped, never fatal)", mixed.length === 2 && mixed[0].name === "e2e-harness" && mixed[1].name === "ci_2");
}

const SVC_SECRET = "svc-token-test-value";
const SVC_SHA = createHash("sha256").update(SVC_SECRET, "utf-8").digest("hex");
{
  const auth = makeServiceTokenAuthenticator([{ name: "e2e-harness", sha256: SVC_SHA }]);
  const id = await auth(reqWith(SVC_SECRET));
  ok(
    "service tokens: a matching token -> svc:<name>, readOnly, admin-read roles",
    id?.issuer === SERVICE_TOKEN_ISSUER && id?.subject === "svc:e2e-harness" && id?.readOnly === true && id?.roles.includes("admin") === true,
  );
  ok("service tokens: a wrong token -> null", (await auth(reqWith("not-the-token"))) === null);
  ok("service tokens: no bearer -> null", (await auth(reqWith())) === null);

  const direct = verifyServiceToken(SVC_SECRET, [{ name: "e2e-harness", sha256: SVC_SHA }]);
  ok("verifyServiceToken: matching value -> the same readOnly svc principal", direct?.subject === "svc:e2e-harness" && direct?.readOnly === true);
  ok("verifyServiceToken: wrong value -> null", verifyServiceToken("nope", [{ name: "e2e-harness", sha256: SVC_SHA }]) === null);
  ok("verifyServiceToken: empty token -> null", verifyServiceToken("", [{ name: "e2e-harness", sha256: SVC_SHA }]) === null);
  ok("verifyServiceToken: no entries -> null (mode off)", verifyServiceToken(SVC_SECRET, []) === null);
}

{
  for (const k of ["OE_ADMIN_OIDC_ISSUER", "OE_ADMIN_OIDC_AUDIENCE", "OE_ADMIN_STATIC_TOKEN", "OE_CONTROL_READ_TOKENS"]) delete process.env[k];
  resetSettingsForTest();
  ok("resolve: nothing configured -> null (fail-closed, unchanged)", (await resolveAdminAuthenticator()) === null);

  process.env.OE_CONTROL_READ_TOKENS = `e2e-harness:${SVC_SHA}`;
  const viaOnRamp = await resolveAdminAuthenticator();
  ok("resolve: OE_CONTROL_READ_TOKENS alone (env on-ramp) arms the authenticator", viaOnRamp !== null);
  ok("resolve: the service token authenticates as its svc principal", (await viaOnRamp!(reqWith(SVC_SECRET)))?.subject === "svc:e2e-harness");
  ok("resolve: garbage bearer is still refused", (await viaOnRamp!(reqWith("garbage"))) === null);
  delete process.env.OE_CONTROL_READ_TOKENS;
}

{
  const { randomBytes } = await import("node:crypto");
  const { setOperatorSecret, removeOperatorSecret } = await import("../agent/credentials/operator-secrets.js");
  const { resetControlSecretCache, CONTROL_SECRET_TTL_MS, controlSecret } = await import("../agent/control/control-secrets.js");
  const { oauthSigningSecret } = await import("../agent/control/oauth-tokens.js");
  const { readTokenEntries } = await import("../agent/control/auth.js");
  const savedKey = process.env.OE_CREDENTIAL_ENCRYPTION_KEY;
  process.env.OE_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  resetSettingsForTest();

  await setOperatorSecret({ name: "OE_CONTROL_READ_TOKENS", value: `stored-harness:${SVC_SHA}`, setBy: "operator:cli" });
  const stored = await resolveAdminAuthenticator();
  ok("store: a STORED OE_CONTROL_READ_TOKENS arms the authenticator with no env var", stored !== null && process.env.OE_CONTROL_READ_TOKENS === undefined);
  ok("store: …and the stored entry authenticates its svc principal", (await stored!(reqWith(SVC_SECRET)))?.subject === "svc:stored-harness");
  await removeOperatorSecret("OE_CONTROL_READ_TOKENS");
  ok("store: inside the memo window the stored answer is reused", (await readTokenEntries()).length === 1);
  ok("store: …and past the window the deleted row reads as unset", (await controlSecret("OE_CONTROL_READ_TOKENS", Date.now() + CONTROL_SECRET_TTL_MS + 1)) === undefined);
  resetControlSecretCache();
  ok("store: a deleted row closes the door once the memo is gone", (await resolveAdminAuthenticator()) === null);

  process.env.OE_CONTROL_READ_TOKENS = `env-harness:${SVC_SHA}`;
  await setOperatorSecret({ name: "OE_CONTROL_READ_TOKENS", value: `stored-harness:${SVC_SHA}`, setBy: "operator:cli" });
  resetControlSecretCache();
  ok("store: with a row AND an env var, the row wins", (await (await resolveAdminAuthenticator())!(reqWith(SVC_SECRET)))?.subject === "svc:stored-harness");
  await removeOperatorSecret("OE_CONTROL_READ_TOKENS");
  resetControlSecretCache();
  ok("store: after the row is deleted, the still-set env var answers again", (await (await resolveAdminAuthenticator())!(reqWith(SVC_SECRET)))?.subject === "svc:env-harness");
  delete process.env.OE_CONTROL_READ_TOKENS;
  resetControlSecretCache();

  await setOperatorSecret({ name: "OE_CONTROL_READ_TOKENS", value: `stored-harness:${SVC_SHA}`, setBy: "operator:cli" });
  resetControlSecretCache();
  const armedKey = process.env.OE_CREDENTIAL_ENCRYPTION_KEY;
  delete process.env.OE_CREDENTIAL_ENCRYPTION_KEY;
  let faulted = false;
  try {
    await readTokenEntries();
  } catch {
    faulted = true;
  }
  ok("store: a stored row under an unarmed key REJECTS (a fault), it does not read as unset", faulted);
  process.env.OE_CREDENTIAL_ENCRYPTION_KEY = armedKey;
  await removeOperatorSecret("OE_CONTROL_READ_TOKENS");
  resetControlSecretCache();

  const signing = "s".repeat(48);
  await setOperatorSecret({ name: "OE_CONTROL_OAUTH_SIGNING_SECRET", value: signing, setBy: "operator:cli" });
  ok("store: oauthSigningSecret() with no argument reads the STORED key", (await oauthSigningSecret()) === signing);
  await removeOperatorSecret("OE_CONTROL_OAUTH_SIGNING_SECRET");
  resetControlSecretCache();
  ok("store: NEGATIVE CONTROL — with the row gone the plane is unarmed (null)", (await oauthSigningSecret()) === null);

  await setOperatorSecret({ name: "OE_ADMIN_STATIC_TOKEN", value: "stored-static-2650", setBy: "operator:cli" });
  resetControlSecretCache();
  const admin = await (await resolveAdminAuthenticator())!(reqWith("stored-static-2650"));
  ok("store: a STORED OE_ADMIN_STATIC_TOKEN is the admin credential", admin !== null && admin.roles.includes("admin"));
  process.env.OE_ADMIN_STATIC_TOKEN = "retired-env-static";
  ok("store: the stored value wins — a retired env value authenticates nobody", (await (await resolveAdminAuthenticator())!(reqWith("retired-env-static"))) === null);
  delete process.env.OE_ADMIN_STATIC_TOKEN;
  await removeOperatorSecret("OE_ADMIN_STATIC_TOKEN");
  resetControlSecretCache();

  if (savedKey === undefined) delete process.env.OE_CREDENTIAL_ENCRYPTION_KEY;
  else process.env.OE_CREDENTIAL_ENCRYPTION_KEY = savedKey;
}

{
  resetSettingsForTest();
  ok("settings: control.githubAdmin off (shipped) + nothing else configured -> null", (await resolveAdminAuthenticator()) === null);
  overrideSettingsForTest({ control: { githubAdmin: true } });
  ok("settings: control.githubAdmin on arms the authenticator with nothing in env", (await resolveAdminAuthenticator()) !== null);
  resetSettingsForTest();

  process.env.OE_ADMIN_OIDC_ISSUER = ISSUER;
  process.env.OE_ADMIN_OIDC_AUDIENCE = AUDIENCE;
  ok("settings: the retired OE_ADMIN_OIDC_* env pair arms nothing", (await resolveAdminAuthenticator()) === null);
  delete process.env.OE_ADMIN_OIDC_ISSUER;
  delete process.env.OE_ADMIN_OIDC_AUDIENCE;
  overrideSettingsForTest({ control: { adminOidc: { issuer: ISSUER, audience: AUDIENCE } } });
  ok("settings: control.adminOidc { issuer, audience } arms the authenticator", (await resolveAdminAuthenticator()) !== null);
  resetSettingsForTest();
  for (const [bad, why] of [
    [{ issuer: ISSUER, audience: "" }, "half a pair"],
    [{ issuer: "", audience: AUDIENCE }, "half a pair"],
    [{ issuer: "http://accounts.example.com", audience: AUDIENCE }, "https"],
    [{ issuer: "not a url", audience: AUDIENCE }, "issuer URL"],
  ] as const) {
    let message = "";
    try {
      defineSettings({ control: { adminOidc: bad } });
    } catch (err) {
      message = String(err);
    }
    ok(`settings: defineSettings refuses control.adminOidc with ${why}`, message.includes("control.adminOidc"));
  }
  let accepted = true;
  try {
    defineSettings({ control: { adminOidc: { issuer: ISSUER, audience: AUDIENCE } } });
    defineSettings({ control: { adminOidc: { issuer: "", audience: "" } } });
  } catch {
    accepted = false;
  }
  ok("settings: NEGATIVE CONTROL — a full pair and an empty pair are both accepted", accepted);

  process.env.OE_ADMIN_STATIC_TOKEN = "s3cret-2411";
  overrideSettingsForTest({ control: { adminRoleRules: [{ roles: ["domain:finance"], issuer: "static" }] } });
  const ruled = await (await resolveAdminAuthenticator())!(reqWith("s3cret-2411"));
  ok(
    "settings: a control.adminRoleRules rule grants its roles to a matching identity",
    ruled !== null && ruled.roles.includes("domain:finance") && ruled.roles.includes("admin"),
  );
  resetSettingsForTest();
  const unruled = await (await resolveAdminAuthenticator())!(reqWith("s3cret-2411"));
  ok("settings: …and with no declared rule the identity holds only the implied admin role", unruled !== null && !unruled.roles.includes("domain:finance"));
  delete process.env.OE_ADMIN_STATIC_TOKEN;

  let refused = "";
  try {
    defineSettings({ control: { adminRoleRules: [{ roles: ["admin"] }] } });
  } catch (err) {
    refused = String(err);
  }
  ok("settings: defineSettings refuses an admin role rule that names no matcher", refused.includes("control.adminRoleRules") && refused.includes("names no matcher"));
}

{
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  async function listen(server: import("node:http").Server): Promise<string> {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  }
  const mcpClient = async (url: string, bearerTok: string) => {
    const client = new Client({ name: "svc-test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${bearerTok}` } } }));
    return client;
  };

  const svcName = `svc-test-${process.pid}-${Date.now()}`;
  process.env.OE_CONTROL_READ_TOKENS = `${svcName}:${SVC_SHA}`;
  const authenticate = await resolveAdminAuthenticator();
  const server = createAdminHttpServer({ authenticate: authenticate!, includeWrites: true });
  const url = await listen(server);

  const wrong = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer wrong-token" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  ok("service tokens over HTTP: a wrong token is refused (401)", wrong.status === 401);

  const client = await mcpClient(url, SVC_SECRET);
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  ok("service principal: tools/list is EXACTLY the read views (usage_window included)", JSON.stringify(names) === JSON.stringify([...CONTROL_TOOL_NAMES].sort()));
  ok("service principal: ZERO write tools registered on an includeWrites mount", CONTROL_WRITE_TOOL_NAMES.every((w) => !names.includes(w)));

  const report = await client.callTool({ name: "spend_report", arguments: {} });
  ok("service principal: a read view executes", /^\d{4}-\d{2}$/.test(JSON.parse((report.content as { type: string; text: string }[])[0].text).period));
  const uw = await client.callTool({ name: "usage_window", arguments: { sinceIso: new Date(Date.now() - 3_600_000).toISOString(), workspaceKeys: ["slack/T_NOSUCH"] } });
  ok("service principal: usage_window is callable (org-wide read via the svc roles)", uw.isError !== true);

  let writeRefused = false;
  try {
    const res = await client.callTool({ name: "set_spend_limit", arguments: { org: "default", scopeKey: "slack/T1/C1", level: "surface", monthlyTokens: 1 } });
    writeRefused = res.isError === true;
  } catch {
    writeRefused = true;
  }
  ok("service principal: a write tool call is refused (tool not registered — fail-closed by absence)", writeRefused);
  await client.close();

  const adminServer = createAdminHttpServer({ authenticate: async () => ({ issuer: "t", subject: "s", emailVerified: false, roles: ["admin"] }), includeWrites: true });
  const adminUrl = await listen(adminServer);
  const adminClient = await mcpClient(adminUrl, "anything");
  const adminNames = (await adminClient.listTools()).tools.map((t) => t.name);
  ok("contrast: an admin identity on the same mount still gets the write tools", CONTROL_WRITE_TOOL_NAMES.every((w) => adminNames.includes(w)));
  await adminClient.close();
  adminServer.close();

  const audited = await readAudit({ org: deploymentOrg(), principalId: `svc:${svcName}`, limit: 100 });
  ok("service principal: every call is audited as control.service_call with the service name", audited.length >= 2 && audited.every((e) => e.action === "control.service_call"));
  ok(
    "service principal: the audit detail records the JSON-RPC method (and tool when called)",
    audited.some((e) => (e.detail as { tool?: string } | undefined)?.tool === "spend_report") && audited.some((e) => (e.detail as { method?: string } | undefined)?.method === "tools/list"),
  );

  server.close();
  delete process.env.OE_CONTROL_READ_TOKENS;
}

{
  const readValue = "read-token-value";
  const injectValue = "inject-token-value";
  const sha = (v: string) => createHash("sha256").update(v, "utf-8").digest("hex");
  const readEntries = parseServiceTokenEntries(`e2e-harness:${sha(readValue)}`);
  const injectEntries = parseServiceTokenEntries(`eval-inject:${sha(injectValue)}`);
  ok("(precondition) both token families parsed one entry each", readEntries.length === 1 && injectEntries.length === 1);

  const req = (token: string | null, scheme = "Bearer") =>
    new Request("https://deploy.example/control/v1/usage", { headers: token ? { authorization: `${scheme} ${token}` } : {} });

  const readAuth = serviceTokenAuth(readEntries);
  const injectAuth = injectTokenAuth(injectEntries);

  const verified = await readAuth(req(readValue));
  ok("read family: a matching bearer becomes an eve caller snapshot", verified !== null && verified !== undefined);
  ok("read family: principalId is the audited service principal svc:<name>", verified?.principalId === "svc:e2e-harness");
  ok("read family: the caller is a SERVICE principal, issued by the service-token issuer", verified?.principalType === "service" && verified?.issuer === SERVICE_TOKEN_ISSUER);
  ok("read family: the snapshot names WHICH family admitted the caller", verified?.attributes[TOKEN_FAMILY_ATTR] === "read");
  ok("read family: the authenticator is named, so an audit reader can tell the two doors apart", verified?.authenticator === SERVICE_TOKEN_AUTHENTICATOR);
  ok("read family: the bag declares an UNATTENDED origin — a token door is machine-to-machine, never a human acting", verified?.attributes[FIRE_UNATTENDED_ATTR] === "true");

  ok("read family: a wrong token SKIPS the walk entry (no snapshot)", (await readAuth(req("not-the-token"))) === null);
  ok("read family: no authorization header at all skips", (await readAuth(req(null))) === null);
  ok("read family: a non-Bearer scheme skips", (await readAuth(req(Buffer.from("u:p").toString("base64"), "Basic"))) === null);

  ok("families stay disjoint: a READ token is refused by the injection walk", (await injectAuth(req(readValue))) === null);
  ok("families stay disjoint: an INJECT token is refused by the read walk", (await readAuth(req(injectValue))) === null);
  const injected = await injectAuth(req(injectValue));
  ok("inject family: a matching bearer authenticates as svc:<name>, tagged as the inject family", injected?.principalId === "svc:eval-inject" && injected?.attributes[TOKEN_FAMILY_ATTR] === "inject");
  ok("inject family: the authenticator is the injection one, never the read one", injected?.authenticator === INJECT_TOKEN_AUTHENTICATOR);
  ok("inject family: the bag declares an UNATTENDED origin too — the marker cannot be on one door and missing on the other", injected?.attributes[FIRE_UNATTENDED_ATTR] === "true");

  const refused = await routeAuth(req("not-the-token"), readAuth);
  ok("walk: an unverified caller gets a Response, not a snapshot", refused instanceof Response);
  const res = refused as Response;
  ok("walk: the refusal is a 401", res.status === 401);
  ok("walk: the 401 advertises the Bearer challenge the door actually accepts", (res.headers.get("www-authenticate") ?? "").toLowerCase().includes("bearer"));
  ok("walk: the 401 is never cached", (res.headers.get("cache-control") ?? "").includes("no-store"));
  const accepted = await routeAuth(req(readValue), readAuth);
  ok("walk: a matching caller returns the snapshot, not a Response", !(accepted instanceof Response) && accepted.principalId === "svc:e2e-harness");
}

console.log(`\n✓ control auth: ${n} assertions passed (OIDC verify, identity model, verified-email linking + guardrails, RBAC, read-only service tokens, eve route-auth walk)\n`);

// proves: SET-071, SET-072, SET-092
