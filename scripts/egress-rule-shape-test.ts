import assert from "node:assert/strict";

import type { SandboxNetworkPolicy, SandboxNetworkRule } from "eve/sandbox";
import { _setBrowserHostsForTest, resetBrowserHostsForTest } from "../packages/core/agent/access/browser-hosts.js";
import type { Connection } from "../packages/core/agent/access/bundle.js";
import { compileNetworkPolicy, egressAllowMap } from "../packages/core/agent/access/egress.js";
import { registerExtraEgressHosts, resetExtraEgressHostsForTest } from "../packages/core/agent/access/extra-hosts.js";
import { TRUSTED_ACCESS_HOSTS } from "../packages/core/agent/access/network-access.js";
import type { EffectiveAccess, ReachableHost } from "../packages/core/agent/access/resolver.js";
import { mergeGitBrokerRules, tokenGitReadRules, withBareAllowHost } from "../packages/core/agent/scm/broker.js";
import { overrideSettingsForTest, resetSettingsForTest } from "../packages/core/agent/settings/settings.js";
import { loadIsSandboxNetworkPolicy } from "./eve-deep-reads/network-policy.js";

// The egress policy is the sandbox firewall. Its hosts and methods are the security control. This
// test compiles every rule form OE declares, and checks two things for each policy:
//   1. eve's own runtime check (`isSandboxNetworkPolicy`) takes the policy, so the shape is eve's.
//   2. A hand-written table of host -> rules equals the compiled policy. A dropped host, a dropped
//      rule, a lost method narrowing, a lost path narrowing or a moved credential changes the table.
// The negative controls show that the table compare and eve's check both refuse a bad policy.

const isSandboxNetworkPolicy = await loadIsSandboxNetworkPolicy(process.cwd());

let failed = 0;
let passed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}\n       ${err instanceof Error ? err.message : String(err)}`);
  }
}

const RULE_KEYS: ReadonlySet<string> = new Set(["match", "transform"]);
const MATCH_KEYS: ReadonlySet<string> = new Set(["method", "path", "queryString"]);

function matcher(m: unknown): string {
  const entries = Object.entries(m as Record<string, string>);
  assert.equal(entries.length, 1, `a matcher sets exactly one key: ${JSON.stringify(m)}`);
  const [kind, value] = entries[0]!;
  return `${kind}:${value}`;
}

/** One line per rule. Every narrowing field is in the line, so a widened rule prints a different line. */
function describeRule(rule: SandboxNetworkRule): string {
  const stray = Object.keys(rule).filter((key) => !RULE_KEYS.has(key));
  assert.deepEqual(stray, [], `an OE rule carries only match and transform: ${JSON.stringify(rule)}`);
  assert.ok("transform" in rule, `an OE rule always has a transform: ${JSON.stringify(rule)}`);
  const m = rule.match ?? {};
  const strayMatch = Object.keys(m).filter((key) => !MATCH_KEYS.has(key));
  assert.deepEqual(strayMatch, [], `an OE match carries only method, path and queryString: ${JSON.stringify(m)}`);
  const methods = m.method === undefined ? "*" : [...m.method].sort().join(",");
  const path = m.path === undefined ? "*" : matcher(m.path);
  const query = (m.queryString ?? []).map((q) => `${q.key ? matcher(q.key) : "*"}=${q.value ? matcher(q.value) : "*"}`).join("&") || "*";
  const headers =
    rule.transform
      .flatMap((t) => Object.entries(t.headers ?? {}))
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join(";") || "none";
  return `${methods} ${path} ${query} stamp:${headers}`;
}

type Table = Record<string, readonly string[]>;

function tableOf(policy: SandboxNetworkPolicy): Table | string {
  if (typeof policy === "string") return policy;
  const out: Record<string, readonly string[]> = {};
  for (const [host, rules] of Object.entries(egressAllowMap(policy)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    out[host] = rules.map(describeRule);
  }
  return out;
}

/** The check every compiled policy passes: eve takes it, and its table is the expected one. */
function assertPolicy(label: string, policy: SandboxNetworkPolicy, expected: Table | string): void {
  assert.equal(isSandboxNetworkPolicy(policy), true, `${label}: eve's isSandboxNetworkPolicy refuses the policy ${JSON.stringify(policy)}`);
  assert.deepEqual(tableOf(policy), expected, `${label}: the compiled hosts and rules differ from the declared ones`);
}

const conn = (id: string): Connection => ({ id, credentialType: "api-key", secretRef: "FIXTURE_KEY", allowedWebsites: [] }) as unknown as Connection;

function access(reachableHosts: readonly ReachableHost[], connections: readonly Connection[], repos: readonly string[] = []): EffectiveAccess {
  return { connections, reachableHosts, repos } as unknown as EffectiveAccess;
}

const headers = async (c: Connection): Promise<Record<string, string>> => ({ authorization: `Bearer fixture-${c.id}` });
const grantAll = async (ids: readonly string[]): Promise<readonly string[]> => ids.filter((id) => id !== "c-ungranted");

const HOSTS: readonly ReachableHost[] = [
  { host: "api.notion.example", viaConnection: "c-notion", methods: ["GET", "POST"], pathPrefixes: ["/v1/pages", "/v1/search"] },
  { host: "api.tracker.example", viaConnection: "c-tracker", methods: ["POST"] },
  { host: "hooks.example.com", viaConnection: "c-hooks" },
  { host: "files.example.com", viaConnection: "c-files", pathPrefixes: ["/public/"] },
  { host: "raw.example.org", viaConnection: null },
  { host: "api.ungranted.example", viaConnection: "c-ungranted", methods: ["GET"] },
];
const CONNECTIONS = ["c-notion", "c-tracker", "c-hooks", "c-files", "c-ungranted", "c-browser"].map(conn);

const EXPECTED_BASE: Table = {
  "api.notion.example": ["GET,POST startsWith:/v1/pages * stamp:authorization=Bearer fixture-c-notion", "GET,POST startsWith:/v1/search * stamp:authorization=Bearer fixture-c-notion"],
  "api.tracker.example": ["POST * * stamp:authorization=Bearer fixture-c-tracker"],
  "app.browser.example": ["GET,POST * * stamp:authorization=Bearer fixture-c-browser"],
  "docs.browser.example": ["GET,HEAD * * stamp:none"],
  "extra.example.net": [],
  "files.example.com": ["* startsWith:/public/ * stamp:authorization=Bearer fixture-c-files"],
  "github.com": [],
  "hooks.example.com": ["* * * stamp:authorization=Bearer fixture-c-hooks"],
  "raw.example.org": [],
};

async function compileFixture(level?: "none" | "trusted" | "full"): Promise<SandboxNetworkPolicy> {
  resetExtraEgressHostsForTest();
  registerExtraEgressHosts("egress-rule-shape-test", ["extra.example.net"]);
  overrideSettingsForTest({ browser: { enabled: true } });
  _setBrowserHostsForTest([
    { host: "docs.browser.example", methods: ["GET", "HEAD"], why: "fixture" },
    { host: "app.browser.example", methods: ["GET", "POST"], credential: "c-browser", why: "fixture" },
  ]);
  try {
    return await compileNetworkPolicy(access(HOSTS, CONNECTIONS, ["acme/web"]), headers, grantAll, level);
  } finally {
    resetBrowserHostsForTest();
    resetExtraEgressHostsForTest();
    resetSettingsForTest();
  }
}

await test("every rule form OE compiles is in eve's shape, with the declared hosts and methods", async () => {
  assertPolicy("compileNetworkPolicy", await compileFixture(), EXPECTED_BASE);
});

await test("an ungranted connection's host is absent, so a type fix never re-opens it", async () => {
  const table = tableOf(await compileFixture()) as Table;
  assert.equal("api.ungranted.example" in table, false);
});

await test("the trusted level adds only the trusted hosts, each with no rule", async () => {
  const expected: Record<string, readonly string[]> = { ...EXPECTED_BASE };
  for (const host of TRUSTED_ACCESS_HOSTS) if (!(host in expected)) expected[host] = [];
  const sorted = Object.fromEntries(Object.entries(expected).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  assertPolicy("trusted", await compileFixture("trusted"), sorted);
});

await test("the full level adds the * host, and nothing else", async () => {
  const expected = Object.fromEntries(Object.entries({ ...EXPECTED_BASE, "*": [] }).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  assertPolicy("full", await compileFixture("full"), expected);
});

await test("an empty access compiles to deny-all", async () => {
  const policy = await compileNetworkPolicy(access([], []), headers, grantAll);
  assertPolicy("empty", policy, "deny-all");
});

const TOKEN_GIT_RULES = [
  "GET regex:^/acme/web\\.git/info/refs(\\?service=git-upload-pack)?$ exact:service=exact:git-upload-pack stamp:Authorization=Basic eC1hY2Nlc3MtdG9rZW46Zml4dHVyZS10b2tlbg==",
  "POST exact:/acme/web.git/git-upload-pack * stamp:Authorization=Basic eC1hY2Nlc3MtdG9rZW46Zml4dHVyZS10b2tlbg==",
];

await test("the token git read-broker keeps the fetch-only methods, paths and query on both git hosts", async () => {
  const merged = mergeGitBrokerRules(await compileFixture(), tokenGitReadRules("fixture-token", ["acme/web", "not a repo"]));
  assertPolicy("token broker", merged, { ...EXPECTED_BASE, "codeload.github.com": TOKEN_GIT_RULES, "github.com": TOKEN_GIT_RULES });
});

await test("the app git read-broker keeps the owner path prefix", async () => {
  const ownerRule = { match: { path: { startsWith: "/acme/" } }, transform: [{ headers: { Authorization: "Basic fixture" } }] };
  const merged = mergeGitBrokerRules(await compileFixture(), [ownerRule]);
  const rule = ["* startsWith:/acme/ * stamp:Authorization=Basic fixture"];
  assertPolicy("app broker", merged, { ...EXPECTED_BASE, "codeload.github.com": rule, "github.com": rule });
});

await test("the git read-broker on a deny-all base opens only the two git hosts", async () => {
  const merged = mergeGitBrokerRules("deny-all", tokenGitReadRules("fixture-token", ["acme/web"]));
  assertPolicy("broker on deny-all", merged, { "codeload.github.com": TOKEN_GIT_RULES, "github.com": TOKEN_GIT_RULES });
});

await test("a bare allow host adds one host with no rule, and keeps every other rule", async () => {
  const policy = withBareAllowHost(await compileFixture(), "proxy.example.com");
  const expected = Object.fromEntries(Object.entries({ ...EXPECTED_BASE, "proxy.example.com": [] }).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  assertPolicy("bare host", policy, expected);
  assert.equal(withBareAllowHost("deny-all", "proxy.example.com"), "deny-all", "a string policy stays as it is");
});

await test("eve's host-list form reads as hosts with no rule, never as index keys", async () => {
  const merged = mergeGitBrokerRules({ allow: ["raw.example.org"] }, tokenGitReadRules("fixture-token", ["acme/web"]));
  assertPolicy("host list", merged, { "codeload.github.com": TOKEN_GIT_RULES, "github.com": TOKEN_GIT_RULES, "raw.example.org": [] });
});

await test("the git read-broker keeps the base policy's subnet rules", () => {
  const subnets = { deny: ["10.0.0.0/8"], allow: ["192.0.2.0/24"] };
  const merged = mergeGitBrokerRules({ allow: { "raw.example.org": [] }, subnets }, tokenGitReadRules("fixture-token", ["acme/web"]));
  assert.equal(isSandboxNetworkPolicy(merged), true);
  assert.deepEqual(typeof merged === "string" ? undefined : merged.subnets, subnets, "a merge that drops subnets.deny widens what the sandbox may reach");
  const bare = withBareAllowHost({ allow: { "raw.example.org": [] }, subnets }, "proxy.example.com");
  assert.deepEqual(typeof bare === "string" ? undefined : bare.subnets, subnets, "withBareAllowHost keeps the subnet rules too");
});

function withoutOneRule(policy: SandboxNetworkPolicy, host: string): SandboxNetworkPolicy {
  const allow = { ...egressAllowMap(policy) };
  allow[host] = allow[host]!.slice(1);
  return { allow };
}

function widened(policy: SandboxNetworkPolicy, host: string, drop: "method" | "path"): SandboxNetworkPolicy {
  const allow = { ...egressAllowMap(policy) };
  allow[host] = allow[host]!.map((rule) => {
    const { [drop]: _gone, ...match } = rule.match ?? {};
    return { ...rule, match };
  });
  return { allow };
}

await test("negative control: the table compare refuses a dropped, widened or added rule", async () => {
  const base = await compileFixture();
  const refused = (label: string, policy: SandboxNetworkPolicy): void => {
    assert.throws(() => assertPolicy(label, policy, EXPECTED_BASE), /differ from the declared ones/u, `${label}: the compare passed a bad policy`);
  };
  refused("a dropped path-prefix rule", withoutOneRule(base, "api.notion.example"));
  refused("a dropped host", (() => {
    const allow = { ...egressAllowMap(base) };
    delete allow["api.tracker.example"];
    return { allow };
  })());
  refused("a lost method narrowing", widened(base, "api.tracker.example", "method"));
  refused("a lost path narrowing", widened(base, "files.example.com", "path"));
  refused("an added * host", { allow: { ...egressAllowMap(base), "*": [] } });
  refused("a credential on the wrong host", {
    allow: { ...egressAllowMap(base), "raw.example.org": [{ transform: [{ headers: { authorization: "Bearer fixture-c-hooks" } }] }] },
  });
});

await test("negative control: eve's check refuses the shapes the old OE rule type allowed", () => {
  assert.equal(isSandboxNetworkPolicy({ allow: { "h.example": [{ match: { path: { startsWith: "/a", exact: "/a" } }, transform: [] }] } }), false, "two matcher keys");
  assert.equal(isSandboxNetworkPolicy({ allow: { "h.example": [{ match: { path: {} }, transform: [] }] } }), false, "no matcher key");
  assert.equal(isSandboxNetworkPolicy({ allow: { "h.example": [{ match: { method: ["GET"] } }] } }), false, "no transform and no forwardURL");
  assert.equal(isSandboxNetworkPolicy({ allow: { "h.example": [{ match: { method: ["GET"] }, transform: [] }] } }), true, "positive control: a method rule with an empty transform");
});

console.log(`\negress-rule-shape: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
