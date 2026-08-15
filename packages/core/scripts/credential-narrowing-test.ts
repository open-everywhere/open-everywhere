import assert from "node:assert/strict";
import {
  credentialEndpointProblems,
  credentialEndpointVerdict,
  assertCredentialEndpointAllowed,
  guardCredentialFetch,
  CredentialEndpointError,
  CREDENTIAL_HTTP_METHODS,
  type CredentialEndpointRules,
} from "../agent/access/credential-endpoints.js";
import {
  assertConnectorCredentialsValid,
  expandConnectorGrant,
  defineConnectorCredentials,
  type ConnectorCredentials,
} from "../agent/access/connector-credentials.js";
import { registerBroker, resetBrokers, type CredentialBroker } from "../agent/access/credentials.js";
import { resolveAppTokenFromCred } from "../agent/connections/connector-auth.js";
import { lintCredentialCollisions } from "../agent/access/lint.js";
import { defineBundle, defineBinding, type Binding, type Bundle } from "../agent/access/bundle.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const READ_ONLY: CredentialEndpointRules = {
  hosts: ["api.notion.com"],
  pathPrefixes: ["/v1/comments"],
  methods: ["GET", "HEAD"],
};

const problemsOf = (rules: unknown): readonly string[] =>
  credentialEndpointProblems(rules as CredentialEndpointRules | undefined, "provider \"p\" credential \"c\"");

ok(problemsOf(undefined).length === 0, "§1 declaring NO endpoint rules is clean — absent means unnarrowed, not misconfigured");
ok(problemsOf(READ_ONLY).length === 0, "§1 a well-formed host+path+method rule is clean");
ok(problemsOf({ hosts: ["api.notion.com"] }).length === 0, "§1 hosts alone is clean — path and method narrowing are independently optional");

ok(problemsOf({ hosts: [] }).length > 0, "§1 an EMPTY hosts list is refused — it would block everything, which is a config error not a posture");
ok(problemsOf({}).length > 0, "§1 a rule with no `hosts` field at all is refused");

const wildcard = problemsOf({ hosts: ["*.notion.com"] });
ok(wildcard.length > 0, "🔴 §1 a WILDCARD host is refused — hosts are never wildcardable");
ok(wildcard.some((p) => p.includes("wildcard")), "§1 the wildcard refusal says WHY, naming the wildcard");

ok(problemsOf({ hosts: ["https://api.notion.com"] }).length > 0, "§1 a host entry carrying a SCHEME is refused — it is a bare hostname, not a URL");
ok(problemsOf({ hosts: ["api.notion.com:443"] }).length > 0, "§1 a host entry carrying a PORT is refused — ports are not part of the fence");
ok(problemsOf({ hosts: ["api.notion.com/v1"] }).length > 0, "§1 a host entry carrying a PATH is refused");
ok(problemsOf({ hosts: [""] }).length > 0, "§1 an empty-string host is refused");
ok(problemsOf({ hosts: ["api.notion.com", "API.NOTION.COM"] }).length > 0, "§1 a duplicate host is refused — hostnames compare case-insensitively, so these are one entry written twice");

ok(problemsOf({ hosts: ["h.com"], pathPrefixes: [] }).length > 0, "§1 an EMPTY pathPrefixes array is refused — omit the field to admit every path");
ok(problemsOf({ hosts: ["h.com"], pathPrefixes: ["v1/comments"] }).length > 0, "§1 a path prefix not starting with \"/\" is refused");
ok(problemsOf({ hosts: ["h.com"], pathPrefixes: ["/v1/*"] }).length > 0, "§1 a wildcard in a path prefix is refused — a prefix already matches everything below it");

ok(problemsOf({ hosts: ["h.com"], methods: [] }).length > 0, "§1 an EMPTY methods array is refused — omit the field to admit every method");
ok(problemsOf({ hosts: ["h.com"], methods: ["FETCH"] }).length > 0, "§1 a method outside the HTTP vocabulary is refused");
ok(CREDENTIAL_HTTP_METHODS.length === 6, "§1 the method vocabulary is the six the egress plane already knows");

const allowed = (url: string, method?: string) => credentialEndpointVerdict(READ_ONLY, url, method).allowed;
const refusal = (url: string, method?: string) => credentialEndpointVerdict(READ_ONLY, url, method).reason ?? "";

ok(allowed("https://api.notion.com/v1/comments/abc", "GET"), "§2 the intended request is ALLOWED (positive control — the rule is not blocking everything)");
ok(allowed("https://api.notion.com/v1/comments?block_id=x", "HEAD"), "§2 a second declared method is allowed");
ok(allowed("https://api.notion.com/v1/comments/abc", "get"), "§2 the method compare is case-insensitive — `get` satisfies a declared GET");
ok(allowed("https://API.Notion.com/v1/comments/abc", "GET"), "§2 the host compare is case-insensitive");
ok(credentialEndpointVerdict(READ_ONLY, "https://api.notion.com/v1/comments/abc").allowed, "§2 an omitted method is checked as GET, matching fetch's own default");

ok(!allowed("https://evil.example.com/v1/comments/abc", "GET"), "🔴 §2 ACCEPTANCE: a WRONG HOST is blocked — this is the wrong-credential bug becoming a blocked request");
ok(refusal("https://evil.example.com/v1/comments/abc", "GET").includes("evil.example.com"), "§2 the wrong-host refusal names the host that was refused");
ok(!allowed("https://sub.api.notion.com/v1/comments/abc", "GET"), "🔴 §2 a SUBDOMAIN of an allowed host is blocked — an allowlist entry never widens downward");
ok(!allowed("https://notion.com/v1/comments/abc", "GET"), "🔴 §2 the PARENT domain of an allowed host is blocked — nor upward");
ok(!allowed("https://api.notion.com.evil.test/v1/comments/abc", "GET"), "🔴 §2 a host that merely STARTS WITH an allowed host is blocked — the compare is equality, never a prefix");

ok(!allowed("https://api.notion.com/v1/comments", "POST"), "🔴 §2 ACCEPTANCE: a WRONG METHOD is blocked — a read-only credential cannot be used to write");
ok(refusal("https://api.notion.com/v1/comments", "DELETE").includes("DELETE"), "§2 the wrong-method refusal names the method that was refused");

ok(!allowed("https://api.notion.com/v1/users/me", "GET"), "§2 a path outside the declared prefixes is blocked, even on the right host with the right method");
ok(!allowed("https://api.notion.com/v1/comments/../users/me", "GET"), "§2 a literal `..` cannot walk out of the prefix — URL parsing normalises it away, and the normalised path fails the prefix check");
ok(!allowed("https://api.notion.com/v1/comments/%2e%2e/users/me", "GET"), "§2 a wholly percent-encoded `..` segment is collapsed the same way (the URL spec matches %2e case-insensitively)");
ok(!allowed("https://api.notion.com/v1/comments/%2e%2e%2fusers/me", "GET"), "🔴 §2 `%2e%2e%2f` is blocked — it survives URL normalisation, passes `startsWith`, and decodes to `/v1/comments/../users` at the server");
ok(!allowed("https://api.notion.com/v1/comments/..%2fusers/me", "GET"), "🔴 §2 `..%2f` is blocked for the same reason — the encoded slash is what keeps the segment intact");
ok(!allowed("https://api.notion.com/v1/comments/%zz", "GET"), "§2 a path whose percent-encoding will not decode is blocked — an unreadable path is not a checkable one");

ok(!allowed("file:///etc/passwd", "GET"), "§2 a non-http(s) scheme is blocked");
ok(!allowed("not a url", "GET"), "§2 an unparseable URL is blocked rather than passed through");

ok(credentialEndpointVerdict(undefined, "https://anything.example.com/x", "DELETE").allowed, "§2 a credential with NO rules is unnarrowed — absent must not mean deny-all, or every existing credential breaks");

const HOST_ONLY: CredentialEndpointRules = { hosts: ["api.notion.com"] };
ok(credentialEndpointVerdict(HOST_ONLY, "https://api.notion.com/anything", "DELETE").allowed, "§2 with no methods/pathPrefixes declared, any method and any path on an allowed host is fine");
ok(!credentialEndpointVerdict(HOST_ONLY, "https://elsewhere.test/anything", "GET").allowed, "§2 …but the host narrowing still holds");

assert.doesNotThrow(
  () => assertCredentialEndpointAllowed(READ_ONLY, "https://api.notion.com/v1/comments/abc", "GET", "notion credential"),
  "an allowed request must not throw",
);
n++;

let thrown: unknown;
try {
  assertCredentialEndpointAllowed(READ_ONLY, "https://evil.example.com/v1/comments?token=hunter2", "POST", "provider \"notion\" credential \"channel-key\"");
} catch (e) {
  thrown = e;
}
ok(thrown instanceof CredentialEndpointError, "§3 a refusal throws CredentialEndpointError, so a caller can distinguish it from a transport failure");
const message = thrown instanceof Error ? thrown.message : "";
ok(message.includes("channel-key"), "§3 the message names WHICH credential was about to go somewhere it may not");
ok(message.includes("POST"), "§3 the message names the method");
ok(message.includes("evil.example.com"), "§3 the message names the origin");
ok(!message.includes("hunter2"), "🔴 §3 the message does NOT echo the query string — a query can carry operator data, and no part of the verdict depends on it");

const RESPONSE = new Response("{}", { status: 200 });
function recordingFetch() {
  const calls: Array<{ url: string; method: string }> = [];
  const fn = async (url: string, init?: RequestInit) => {
    calls.push({ url, method: (init?.method ?? "GET").toUpperCase() });
    return RESPONSE;
  };
  return { calls, fn };
}

{
  const base = recordingFetch();
  ok(guardCredentialFetch(undefined, "w", base.fn) === base.fn, "§4 with no rules the guard returns the base fetch BY IDENTITY — an unnarrowed credential's path is unchanged, not merely equivalent");
}

{
  const base = recordingFetch();
  const guarded = guardCredentialFetch(READ_ONLY, "notion credential", base.fn);
  await guarded("https://api.notion.com/v1/comments/abc", { method: "GET" });
  ok(base.calls.length === 1, "§4 an allowed request reaches the underlying fetch (positive control)");
  ok(base.calls[0]!.url === "https://api.notion.com/v1/comments/abc", "§4 …unchanged");
}

{
  const base = recordingFetch();
  const guarded = guardCredentialFetch(READ_ONLY, "notion credential", base.fn);
  await assert.rejects(
    () => guarded("https://evil.example.com/v1/comments/abc", { method: "GET" }),
    (e: unknown) => e instanceof CredentialEndpointError,
    "a wrong-host request must reject with CredentialEndpointError",
  );
  ok(base.calls.length === 0, "🔴 §4 ACCEPTANCE: the underlying fetch was NEVER CALLED on a wrong-host request — the credential did not leave the host");
}

{
  const base = recordingFetch();
  const guarded = guardCredentialFetch(READ_ONLY, "notion credential", base.fn);
  await assert.rejects(
    () => guarded("https://api.notion.com/v1/comments", { method: "POST" }),
    (e: unknown) => e instanceof CredentialEndpointError,
    "a wrong-method request must reject",
  );
  ok(base.calls.length === 0, "🔴 §4 ACCEPTANCE: the underlying fetch was NEVER CALLED on a wrong-method request");
}

{
  const base = recordingFetch();
  const writeOnly: CredentialEndpointRules = { hosts: ["api.notion.com"], methods: ["POST"] };
  const guarded = guardCredentialFetch(writeOnly, "w", base.fn);
  await assert.rejects(() => guarded("https://api.notion.com/v1/comments"), (e: unknown) => e instanceof CredentialEndpointError);
  ok(base.calls.length === 0, "§4 an init-less call is checked as GET — an omitted method is not an unchecked one");
}

const providerWith = (endpoints?: CredentialEndpointRules): ConnectorCredentials =>
  defineConnectorCredentials({
    connector: "notion",
    allows: ["api-key"],
    credentials: [{ id: "channel-key", type: "api-key", secretRef: "db:notion:channel-key", broker: "db", ...(endpoints ? { endpoints } : {}) }],
  });

assert.doesNotThrow(() => assertConnectorCredentialsValid([providerWith(READ_ONLY)]), "a valid endpoint rule must load");
n++;
assert.doesNotThrow(() => assertConnectorCredentialsValid([providerWith()]), "a credential declaring no endpoint rules must load exactly as before");
n++;
assert.throws(
  () => assertConnectorCredentialsValid([providerWith({ hosts: ["*.notion.com"] })]),
  /wildcard/,
  "🔴 §5 a WILDCARD host fails at config load — the fence is validated where the operator can still fix it",
);
n++;
assert.throws(() => assertConnectorCredentialsValid([providerWith({ hosts: [] })]), /non-empty/, "§5 an empty host list fails at config load");
n++;

{
  const { resolved, warnings } = expandConnectorGrant({ name: "notion", credential: "channel-key" }, providerWith(READ_ONLY), { dm: false });
  ok(warnings.length === 0, "§5 a valid grant expands cleanly");
  ok(resolved?.endpoints !== undefined, "§5 the endpoint rules SURVIVE grant expansion — a host-side path could not fence itself otherwise");
  ok(resolved?.endpoints?.hosts[0] === "api.notion.com", "§5 …carrying the declared host");
  ok(resolved?.endpoints?.methods?.join(",") === "GET,HEAD", "§5 …and the declared methods");
}
{
  const { resolved } = expandConnectorGrant({ name: "notion", credential: "channel-key" }, providerWith(), { dm: false });
  ok(resolved !== null && resolved.endpoints === undefined, "§5 a credential with no rules resolves with none — never an invented default");
}

const BOUND_REF = "ope505:bound";
const FALLBACK_REF = "ope505:fallback";
const BROKER = "ope505-test";

let asked: string[] = [];
const probeBroker: CredentialBroker = {
  async getSecret(ref: string) {
    asked.push(ref);
    if (ref === BOUND_REF) throw new Error("401 Unauthorized (the resolved credential was revoked)");
    return `secret-for-${ref}`;
  },
};
registerBroker(BROKER, probeBroker);

const conn = { connector: "notion", fallbackSecretRef: FALLBACK_REF, fallbackBroker: BROKER };

asked = [];
{
  const result = await resolveAppTokenFromCred(conn, null, undefined);
  ok(result.token === `secret-for-${FALLBACK_REF}`, "§6 NEGATIVE CONTROL: with NO credential bound, the RESOLUTION-time fallback still resolves — this arm must keep working");
  ok(asked.join(",") === FALLBACK_REF, "§6 …and the only ref read was the fallback's");
}

asked = [];
{
  await assert.rejects(
    () => resolveAppTokenFromCred(conn, { connector: "notion", credential: "channel-key", type: "api-key", grantFamily: "install", principal: "app", secretRef: BOUND_REF, broker: BROKER }, undefined),
    /401/,
    "a bound credential whose read fails must reject",
  );
  n++;
  ok(asked.includes(BOUND_REF), "§6 the bound credential's ref WAS read (the failure is real, not a skipped path)");
  ok(!asked.includes(FALLBACK_REF), "🔴 §6 INVARIANT: the FALLBACK ref was NEVER read after the bound credential failed — an auth failure must never retry under a different credential");
  ok(asked.length === 1, "🔴 §6 exactly ONE credential was attempted — no second key was tried at all");
}

asked = [];
{
  await assert.rejects(
    () => resolveAppTokenFromCred(conn, { connector: "notion", credential: "oauth", type: "service-oauth", grantFamily: "install", principal: "app", home: { kind: "vercel-connect", config: { connector: "oauth/notion" } } }, undefined),
    "a service-oauth credential whose mint fails must reject",
  );
  n++;
  ok(asked.length === 0, "🔴 §6 INVARIANT: an OAuth mint failure reads NO broker ref at all — it never degrades to the static fallback secret");
}

asked = [];
{
  await assert.rejects(
    () => resolveAppTokenFromCred({ connector: "notion" }, { connector: "notion", credential: "channel-key", type: "api-key", grantFamily: "install", principal: "app", secretRef: BOUND_REF, broker: BROKER }, undefined),
    /401/,
    "a failing bound credential with no fallback configured rejects",
  );
  n++;
  ok(asked.join(",") === BOUND_REF, "§6 …having read only its own ref");
}

resetBrokers();

const grants = (name: string, ...pairs: Array<[string, string]>): Bundle =>
  defineBundle({
    name,
    connectors: pairs.map(([connector, credential]) => ({ name: connector, credential, contentOrigin: "external" as const })),
  });

const boundAt = (bundle: string, domain: string): Binding => defineBinding({ bundle, scope: { level: "domain", domain } });

{
  const bad = grants("pay", ["notion", "channel-key"], ["notion", "pay-key"]);
  const problems = lintCredentialCollisions([bad], []);
  ok(problems.length === 1, "🔴 §7 one bundle granting the SAME provider twice with different credentials is ONE problem");
  ok(problems[0]!.includes("pay-key") && problems[0]!.includes("channel-key"), "§7 …naming both credentials so the operator knows which two collided");
  ok(lintCredentialCollisions([grants("ok", ["notion", "channel-key"], ["linear", "team-key"])], []).length === 0, "§7 NEGATIVE CONTROL: two grants for DIFFERENT providers in one bundle are fine");
  ok(lintCredentialCollisions([grants("dup", ["notion", "channel-key"], ["notion", "channel-key"])], []).length === 0, "§7 NEGATIVE CONTROL: the same provider AND the same credential twice is a harmless duplicate, not a collision");
}

{
  const a = grants("a", ["notion", "channel-key"]);
  const b = grants("b", ["notion", "pay-key"]);
  const collide = lintCredentialCollisions([a, b], [boundAt("a", "eng"), boundAt("b", "eng")]);
  ok(collide.length === 1, "🔴 §7 two bundles bound at the SAME scope granting one provider with different credentials is a collision");
  ok(collide[0]!.includes("\"a\"") && collide[0]!.includes("\"b\""), "§7 …naming both bundles");

  const separate = lintCredentialCollisions([a, b], [boundAt("a", "eng"), boundAt("b", "sales")]);
  ok(separate.length === 0, "🔴 §7 NEGATIVE CONTROL: the SAME two bundles at DIFFERENT scopes are clean — that is narrowest-wins doing its job, and flagging it would break the whole per-domain credential feature");

  const agree = lintCredentialCollisions([a, grants("c", ["notion", "channel-key"])], [boundAt("a", "eng"), boundAt("c", "eng")]);
  ok(agree.length === 0, "§7 NEGATIVE CONTROL: two bundles at one scope AGREEING on the credential is clean");

  ok(lintCredentialCollisions([a, b], [boundAt("a", "eng")]).length === 0, "§7 NEGATIVE CONTROL: an UNBOUND colliding bundle contributes nothing — only bound grants can collide");
}

{
  const a = grants("a", ["notion", "k1"]);
  const b = grants("b", ["notion", "k2"]);
  const differentDomains = lintCredentialCollisions([a, b], [boundAt("a", "eng"), boundAt("b", "eng2")]);
  ok(differentDomains.length === 0, "§7 two `domain` bindings naming DIFFERENT domains are different scopes");
  const sameDomain = lintCredentialCollisions([a, b], [boundAt("a", "eng"), boundAt("b", "eng")]);
  ok(sameDomain.length === 1, "§7 …and the same domain is one scope");
}

console.log(`credential-narrowing-test: ${n} assertions passed`);
