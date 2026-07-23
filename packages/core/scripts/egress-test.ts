import assert from "node:assert/strict";
import { compileNetworkPolicy } from "../agent/access/egress.js";
import { computeEgressPolicy, applyEgressPolicy } from "../agent/hooks/egress.js";
import type { EffectiveAccess, ReachableHost } from "../agent/access/resolver.js";
import type { Connection } from "../agent/access/bundle.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const conn = (id: string): Connection =>
  ({ id, credentialType: "api-key", secretRef: "ACME_KEY", allowedWebsites: ["api.acme.test"] }) as unknown as Connection;

function access(hosts: ReachableHost[], connections: Connection[] = []): EffectiveAccess {
  return {
    mode: "channel",
    scopeKey: "test/ws/surface",
    connections,
    connectorCredentials: {},
    reachableHosts: hosts,
    repos: [],
    plugins: [],
    skills: [],
    subagents: [],
    connectors: [],
    instructionStack: [],
    warnings: [],
  } as unknown as EffectiveAccess;
}

type TestRule = { match?: { method?: string[]; path?: { startsWith?: string } }; transform?: unknown[] };
const rulesFor = (p: Awaited<ReturnType<typeof compileNetworkPolicy>>, host: string): TestRule[] =>
  typeof p === "string" ? [] : (((p as { allow?: Record<string, unknown[]> }).allow?.[host] ?? []) as TestRule[]);

{
  const headers = async () => ({ authorization: "Bearer x" });

  const two = await compileNetworkPolicy(
    access(
      [{ host: "api.acme.test", viaConnection: "acme", methods: ["GET"], pathPrefixes: ["/v1/", "/v2/"] }],
      [conn("acme")],
    ),
    headers,
  );
  const twoRules = rulesFor(two, "api.acme.test");
  ok(twoRules.length === 2, "two pathPrefixes → two allow rules (not silently unrestricted)");
  const prefixes = twoRules.map((r) => r.match?.path?.startsWith).sort();
  ok(prefixes[0] === "/v1/" && prefixes[1] === "/v2/", "each rule carries its own path prefix");
  ok(twoRules.every((r) => r.match?.method?.[0] === "GET"), "every path rule keeps the method match");
  ok(twoRules.every((r) => !!r.transform), "every path rule keeps the credential-injection transform");

  const one = await compileNetworkPolicy(
    access([{ host: "api.acme.test", viaConnection: "acme", pathPrefixes: ["/only/"] }], [conn("acme")]),
    headers,
  );
  const oneRules = rulesFor(one, "api.acme.test");
  ok(oneRules.length === 1 && oneRules[0].match?.path?.startsWith === "/only/", "one prefix → one narrowed rule");

  const zero = await compileNetworkPolicy(
    access([{ host: "api.acme.test", viaConnection: "acme", methods: ["POST"] }], [conn("acme")]),
    headers,
  );
  const zeroRules = rulesFor(zero, "api.acme.test");
  ok(zeroRules.length === 1 && zeroRules[0].match?.path === undefined, "no prefixes → one rule, no path narrowing");
}

{
  const goodAccess = access([{ host: "api.acme.test", viaConnection: null }]);

  const okRes = await computeEgressPolicy(
    () => goodAccess,
    async () => ({ allow: { "api.acme.test": [] } }),
  );
  ok(okRes.compileError === undefined, "no error on the happy path");
  ok(typeof okRes.policy === "object" && "allow" in okRes.policy, "happy path returns the compiled allow policy");
  ok(okRes.scopeKey === "test/ws/surface", "happy path carries the scope key");

  const resolveThrew = await computeEgressPolicy(
    () => {
      throw new Error("binding blew up");
    },
    async () => ({ allow: { "x": [] } }),
  );
  ok(resolveThrew.policy === "deny-all", "resolve failure → deny-all (fail closed, NOT allow-all)");
  ok(!!resolveThrew.compileError && resolveThrew.compileError.includes("binding blew up"), "resolve failure records the error");

  const compileThrew = await computeEgressPolicy(
    () => goodAccess,
    async () => {
      throw new Error("secretRef ACME_KEY is not set");
    },
  );
  ok(compileThrew.policy === "deny-all", "compile failure → deny-all (the missing-secretRef case)");
  ok(!!compileThrew.compileError && compileThrew.compileError.includes("ACME_KEY"), "compile failure records the error");
}

{
  const applied = await applyEgressPolicy(async () => {}, false);
  ok(applied.enforced && applied.enforceError === undefined, "successful apply reports enforced");

  let threw: unknown;
  try {
    await applyEgressPolicy(async () => {
      throw new Error("backend rejected setNetworkPolicy");
    }, false);
  } catch (err) {
    threw = err;
  }
  ok(threw instanceof Error && threw.message.includes("aborting the session"), "apply failure without the escape hatch throws (aborts the session, NOT warn-and-continue)");
  ok(threw instanceof Error && threw.message.includes("OE_ALLOW_UNENFORCED_EGRESS"), "abort error names the escape hatch");
  ok(threw instanceof Error && threw.message.includes("backend rejected setNetworkPolicy"), "abort error carries the underlying cause");

  const degraded = await applyEgressPolicy(async () => {
    throw new Error("backend rejected setNetworkPolicy");
  }, true);
  ok(!degraded.enforced, "escape hatch degrades to unenforced instead of throwing");
  ok(!!degraded.enforceError && degraded.enforceError.includes("backend rejected"), "degraded result records the enforcement error");
}

{
  const { registerExtraEgressHosts, extraEgressHosts, resetExtraEgressHostsForTest } = await import("../agent/access/extra-hosts.js");
  const headers = async () => ({ authorization: "Bearer x" });

  resetExtraEgressHostsForTest();
  const denied = await compileNetworkPolicy(access([]), headers);
  ok(denied === "deny-all", "empty extra-hosts registry: nothing reachable still compiles deny-all (byte-identical flag-off)");

  registerExtraEgressHosts("agent-browser", ["qa.example.com", "Preview.Example.com "]);
  const withExtras = await compileNetworkPolicy(access([]), headers);
  ok(typeof withExtras === "object", "extra hosts lift an otherwise-empty policy off deny-all (an armed browser session can reach its targets)");
  ok(rulesFor(withExtras, "qa.example.com").length === 0, "extra host compiles to a bare allow (empty rule array — the credential-less shape)");
  const allowKeys = typeof withExtras === "object" ? Object.keys((withExtras as { allow: Record<string, unknown> }).allow) : [];
  ok(allowKeys.includes("preview.example.com"), "extra hosts are normalized (trim + lowercase) before merging");

  const credentialed = await compileNetworkPolicy(
    access([{ host: "qa.example.com", viaConnection: "acme", methods: ["GET"] }], [conn("acme")]),
    headers,
  );
  const credRules = rulesFor(credentialed, "qa.example.com");
  ok(credRules.length === 1 && credRules[0].match?.method?.[0] === "GET", "a bundle-declared host keeps its narrowed/credentialed rules (extras never replace an existing entry)");

  registerExtraEgressHosts("agent-browser", ["qa.example.com"]);
  ok(extraEgressHosts().length === 1 && extraEgressHosts()[0] === "qa.example.com", "re-registration replaces the source's host set (boot idempotence)");
  resetExtraEgressHostsForTest();
  ok(extraEgressHosts().length === 0, "reset empties the registry");
  ok((await compileNetworkPolicy(access([]), headers)) === "deny-all", "after reset the empty-access policy is deny-all again");
}

console.log(`\n✓ egress: ${n} assertions passed (pathPrefixes multi-rule + fail-closed policy resolver + abort-on-enforce-failure + capability extra-hosts merge)\n`);
