// proves: connector.grant, egress.policy

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compileNetworkPolicy, openWriteHosts } from "../agent/access/egress.js";
import { computeEgressPolicy, applyEgressPolicy } from "../agent/hooks/egress.js";
import { EgressHostCollisionError, type EffectiveAccess, type ReachableHost } from "../agent/access/resolver.js";
import type { Connection } from "../agent/access/bundle.js";
import { overrideSettingsForTest } from "../agent/settings/settings.js";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";

import { pinSuiteStore } from "./_suite-store.js";
pinSuiteStore("egress");

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
    repoCapabilities: {}, resourceCapabilities: {},

    plugins: [],
    skills: [],
    subagents: [],
    connectors: [],
    instructionStack: [], preApprovalRules: [],
    warnings: [],
  } as unknown as EffectiveAccess;
}

const noOverride = async (ids: readonly string[]) => ids;

type TestRule = { match?: { method?: string[]; path?: { startsWith?: string } }; transform?: unknown[] };
const rulesFor = (p: Awaited<ReturnType<typeof compileNetworkPolicy>>, host: string): TestRule[] =>
  typeof p === "string" ? [] : (((p as { allow?: Record<string, unknown[]> }).allow?.[host] ?? []) as TestRule[]);
const allowOfPolicy = (p: Awaited<ReturnType<typeof compileNetworkPolicy>>): Record<string, unknown> =>
  typeof p === "string" ? {} : ((p as { allow?: Record<string, unknown> }).allow ?? {});

{
  const headers = async () => ({ authorization: "Bearer x" });

  const two = await compileNetworkPolicy(
    access(
      [{ host: "api.acme.test", viaConnection: "acme", methods: ["GET"], pathPrefixes: ["/v1/", "/v2/"] }],
      [conn("acme")],
    ),
    headers,
    noOverride,
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
    noOverride,
  );
  const oneRules = rulesFor(one, "api.acme.test");
  ok(oneRules.length === 1 && oneRules[0].match?.path?.startsWith === "/only/", "one prefix → one narrowed rule");

  const zero = await compileNetworkPolicy(
    access([{ host: "api.acme.test", viaConnection: "acme", methods: ["POST"] }], [conn("acme")]),
    headers,
    noOverride,
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
  const { resolveAccess } = await import("../agent/access/resolver.js");
  const bundles = [
    {
      name: "vendor",
      connections: [{ id: "vendor", credentialType: "api-key", secretRef: "VENDOR_KEY", allowedWebsites: ["api.declared.test"], methods: ["GET"] }],
      connectors: [{ name: "notion", credential: "k", contentOrigin: "internal" }],
    },
  ] as unknown as Parameters<typeof resolveAccess>[1];
  const bindings = [{ bundle: "vendor", scope: { level: "org" } }] as unknown as Parameters<typeof resolveAccess>[2];
  const req = { mode: "channel", platform: "slack", workspace: "T1", channel: "C1" } as unknown as Parameters<typeof resolveAccess>[0];
  const headers = async () => ({ authorization: "Bearer x" });
  const res = await computeEgressPolicy(
    () => resolveAccess(req, bundles, bindings, {}, []),
    (a) => compileNetworkPolicy(a, headers, noOverride),
  );
  ok(res.compileError === undefined && typeof res.policy === "object", "OPE-2723: a bundle that still sets contentOrigin compiles an allow policy");
  const allow = allowOfPolicy(res.policy);
  ok(Object.hasOwn(allow, "api.declared.test"), "🔴 OPE-2723 must-survive: the DECLARED host is allowed");
  ok(!Object.hasOwn(allow, "api.undeclared.test") && Object.keys(allow).every((h) => h === "api.declared.test"), "🔴 OPE-2723 must-survive: an UNDECLARED host is denied (absent from the allow map)");
  const rules = rulesFor(res.policy, "api.declared.test");
  ok(rules.length > 0 && rules.every((r) => JSON.stringify(r.match?.method) === JSON.stringify(["GET"])), "🔴 OPE-2723 must-survive: every rule matches the declared method only, so an undeclared method is denied");
  ok(Object.keys(res.connectorContentOrigin).length === 0, "OPE-2723: the deprecated content-origin map on the egress result is always empty, even for a grant that sets contentOrigin");
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
  ok(threw instanceof Error && threw.message.includes("egress.allowUnenforced"), "abort error names the escape hatch (the SETTING since OPE-411 — an operator told to set a deleted env var would be stuck)");
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
  const denied = await compileNetworkPolicy(access([]), headers, noOverride);
  ok(denied === "deny-all", "empty extra-hosts registry: nothing reachable still compiles deny-all (byte-identical flag-off)");

  registerExtraEgressHosts("agent-browser", ["qa.example.com", "Preview.Example.com "]);
  const withExtras = await compileNetworkPolicy(access([]), headers, noOverride);
  ok(typeof withExtras === "object", "extra hosts lift an otherwise-empty policy off deny-all (an armed browser session can reach its targets)");
  ok(rulesFor(withExtras, "qa.example.com").length === 0, "extra host compiles to a bare allow (empty rule array — the credential-less shape)");
  const allowKeys = typeof withExtras === "object" ? Object.keys((withExtras as { allow: Record<string, unknown> }).allow) : [];
  ok(allowKeys.includes("preview.example.com"), "extra hosts are normalized (trim + lowercase) before merging");

  const credentialed = await compileNetworkPolicy(
    access([{ host: "qa.example.com", viaConnection: "acme", methods: ["GET"] }], [conn("acme")]),
    headers,
    noOverride,
  );
  const credRules = rulesFor(credentialed, "qa.example.com");
  ok(credRules.length === 1 && credRules[0].match?.method?.[0] === "GET", "a bundle-declared host keeps its narrowed/credentialed rules (extras never replace an existing entry)");

  registerExtraEgressHosts("agent-browser", ["qa.example.com"]);
  ok(extraEgressHosts().length === 1 && extraEgressHosts()[0] === "qa.example.com", "re-registration replaces the source's host set (boot idempotence)");
  resetExtraEgressHostsForTest();
  ok(extraEgressHosts().length === 0, "reset empties the registry");
  ok((await compileNetworkPolicy(access([]), headers, noOverride)) === "deny-all", "after reset the empty-access policy is deny-all again");
}

{
  const { _setBrowserHostsForTest, resetBrowserHostsForTest } = await import("../agent/access/browser-hosts.js");
  const { resetExtraEgressHostsForTest } = await import("../agent/access/extra-hosts.js");
  const { resetSettingsForTest } = await import("../agent/settings/settings.js");
  resetExtraEgressHostsForTest();
  overrideSettingsForTest({ browser: { enabled: true } });

  const CANARY = "canary-browser-secret-0xdeadbeef";
  const headers = async (c: Connection) => ({ authorization: `Bearer ${CANARY}-${c.id}` });

  _setBrowserHostsForTest([
    { host: "localhost", methods: ["GET", "POST"], why: "t" },
    { host: "readonly.example.com", methods: ["GET", "HEAD"], why: "t" },
    { host: "vendor.example.com", methods: ["GET", "HEAD", "POST"], credential: "vendor-login", why: "t" },
  ]);

  const compiled = await compileNetworkPolicy(access([], [conn("vendor-login")]), headers, noOverride);
  const vendorRules = rulesFor(compiled, "vendor.example.com");
  ok(vendorRules.length === 1, "a credentialed browser host compiles to exactly one rule");
  ok(
    (vendorRules[0].match?.method ?? []).join(",") === "GET,HEAD,POST",
    "…narrowed to the verbs the DECLARATION admits — the host+method row is the control, not a per-call card",
  );
  ok(
    JSON.stringify(vendorRules[0].transform ?? []).includes(CANARY),
    "🔴 THE CREDENTIAL IS INJECTED AT THE FIREWALL: the compiled rule's `transform` carries it, so the sandbox never holds it",
  );

  const roRules = rulesFor(compiled, "readonly.example.com");
  ok(
    roRules.length === 1 && (roRules[0].match?.method ?? []).join(",") === "GET,HEAD" && (roRules[0].transform ?? []).length === 0,
    "an UNCREDENTIALED row is narrowed too and stamps nothing — the negative control for the transform above",
  );
  ok(!("localhost" in allowOfPolicy(compiled)), "a LOOPBACK row never reaches the firewall at all — it does not leave the sandbox VM");

  const rows = openWriteHosts(compiled, [], [...(await import("../agent/access/browser-hosts.js")).browserEgressHosts()]);
  const vendorRow = rows.find((r) => r.host === "vendor.example.com");
  ok(vendorRow?.credentialed === true && vendorRow.credential === "vendor-login", "the audit row names the credential's IDENTITY — the declaration's connection id");
  ok(!JSON.stringify(rows).includes(CANARY), "…and no rendered row carries a byte of the secret");
  ok(
    rows.find((r) => r.host === "readonly.example.com") === undefined,
    "a read-only browser host is absent from the write-host rows — GET/HEAD opens nothing mutating",
  );

  const unbound = await compileNetworkPolicy(access([], []), headers, noOverride);
  ok(
    !("vendor.example.com" in allowOfPolicy(unbound)),
    "🔴 a declared credential this session does NOT grant OMITS the host — never opens it logged out (the silent-wrong-thing this closes)",
  );
  ok("readonly.example.com" in allowOfPolicy(unbound), "…while the uncredentialed rows are untouched — the narrow is per row");

  const revoked = await compileNetworkPolicy(access([], [conn("vendor-login")]), headers, async () => []);
  ok(!("vendor.example.com" in allowOfPolicy(revoked)), "a break-glass revoke of the connection removes the browser host from the policy");

  const unreadable = await compileNetworkPolicy(access([], [conn("vendor-login")]), headers, async () => null);
  ok(!("vendor.example.com" in allowOfPolicy(unreadable)), "an unreadable override store denies the credentialed browser host, exactly as it denies a bundle host");

  const noHeader = await compileNetworkPolicy(access([], [conn("vendor-login")]), async () => ({}), noOverride);
  ok(!("vendor.example.com" in allowOfPolicy(noHeader)), "a credential that resolves to NO header omits the host rather than opening it bare");

  const bundleWins = await compileNetworkPolicy(
    access([{ host: "vendor.example.com", viaConnection: "bundle-conn", methods: ["GET"] }], [conn("bundle-conn"), conn("vendor-login")]),
    headers,
    noOverride,
  );
  const wonRules = rulesFor(bundleWins, "vendor.example.com");
  ok(
    wonRules.length === 1 && (wonRules[0].match?.method ?? []).join(",") === "GET",
    "a host the BUNDLE already reaches keeps its bundle rules — the browser section adds hosts, it never widens one",
  );

  overrideSettingsForTest({ browser: { enabled: false } });
  const disarmed = await compileNetworkPolicy(access([], [conn("vendor-login")]), headers, noOverride);
  ok(disarmed === "deny-all", "🔴 FLAG OFF: the SAME declaration opens NOTHING — the policy is deny-all, not a bare allow list");
  ok(!("vendor.example.com" in allowOfPolicy(disarmed)), "…and in particular the credentialed third-party host is absent, so no secret is stamped for bash to use");
  ok(!("readonly.example.com" in allowOfPolicy(disarmed)), "…nor is the uncredentialed one");
  resetSettingsForTest();

  resetBrowserHostsForTest();
  ok(
    (await compileNetworkPolicy(access([]), headers, noOverride)) === "deny-all",
    "with the declaration reset the empty-access policy is deny-all again (byte-identical unarmed default)",
  );

  {
    overrideSettingsForTest({ browser: { enabled: true } });
    _setBrowserHostsForTest([{ host: "github.com", methods: ["GET"], credential: "vendor-login", why: "t" }]);
    const thrown = await compileNetworkPolicy(access([], [conn("vendor-login")]), headers, noOverride).then(
      () => null,
      (e: unknown) => e,
    );
    ok(thrown instanceof EgressHostCollisionError, "🔴 a declared browser host on a RESERVED broker host REFUSES the compile — the same error family as a two-connection clash");
    ok(
      (thrown as EgressHostCollisionError).message.includes("github.com") && (thrown as EgressHostCollisionError).message.includes("git read-broker"),
      "…and the message names the host and the broker, so the deny-all audit row is a complete statement of the clash",
    );
    ok(
      (thrown as EgressHostCollisionError).message.includes("declared browser host") &&
        (thrown as EgressHostCollisionError).message.includes("agent/access/browser-hosts.ts") &&
        !(thrown as EgressHostCollisionError).message.includes("two connections claim"),
      "…and it names the DECLARATION and its config file as a route, never 'two connections' — the reader must reach the file that actually holds the row",
    );

    _setBrowserHostsForTest([{ host: "*.github.com", methods: ["GET"], why: "t" }]);
    const wild = await compileNetworkPolicy(access([], []), headers, noOverride).then(() => null, (e: unknown) => e);
    ok(
      wild instanceof EgressHostCollisionError && wild.message.includes("codeload.github.com"),
      "a WILDCARD row covering a reserved host is refused too, and the message names the host it overlaps",
    );
    _setBrowserHostsForTest([{ host: "GitHub.com", methods: ["GET"], why: "t" }]);
    ok(
      (await compileNetworkPolicy(access([], []), headers, noOverride).then(() => null, (e: unknown) => e)) instanceof EgressHostCollisionError,
      "…and an upper-case spelling is normalised before the comparison, so it cannot slip past",
    );

    _setBrowserHostsForTest([{ host: "api.github.com", methods: ["GET"], credential: "vendor-login", why: "t" }]);
    const unreserved = await compileNetworkPolicy(access([], [conn("vendor-login")]), headers, noOverride);
    ok("api.github.com" in allowOfPolicy(unreserved), "CONTROL: `api.github.com` is not reserved — the identical row compiles and opens the host");

    _setBrowserHostsForTest([{ host: "github.com", methods: ["GET"], credential: "vendor-login", why: "t" }]);
    overrideSettingsForTest({ browser: { enabled: false } });
    ok(
      (await compileNetworkPolicy(access([], [conn("vendor-login")]), headers, noOverride)) === "deny-all",
      "FLAG OFF: the same reserved row is not armed, so the compile does not refuse — it simply opens nothing",
    );

    resetSettingsForTest();
    resetBrowserHostsForTest();
  }
}

{
  const { enforceEgress, planEgressApply, egressPolicyFingerprint, EgressReapplyRefusedError, egressPolicyShape, egressPolicyCovers, isTurnEdgeAbort, handleTurnEdgeFailure, EgressBindingDivergenceError, NEVER_ENFORCED } =
    await import("../agent/hooks/egress.js");
  const { WakeSlotWriteError } = await import("../agent/access/wake-slot.js");
  const { DelegatedTaskBindingUnavailableError } = await import("../agent/channels/task-wake.js");
  const hook = (await import("../agent/hooks/egress.js")).default as unknown as {
    events: Record<string, unknown>;
  };
  ok(typeof hook.events["turn.started"] === "function", "G1: the egress hook registers a turn.started handler (the re-apply is WIRED, not just written)");
  ok(typeof hook.events["session.started"] === "function", "G1: session.started still registers (the re-apply ADDS an edge, it does not move one)");

  ok(planEgressApply({ phase: "session.started", fingerprint: "a", lastApplied: "a" }).reapply, "G1: session.started ALWAYS applies (eve's session default is allow-all until we narrow it)");
  ok(!planEgressApply({ phase: "turn.started", fingerprint: "a", lastApplied: "a" }).reapply, "G1: a turn whose policy is unchanged skips the firewall call");
  ok(planEgressApply({ phase: "turn.started", fingerprint: "b", lastApplied: "a" }).reapply, "G1: a turn whose policy CHANGED re-applies");
  ok(planEgressApply({ phase: "turn.started", fingerprint: "a", lastApplied: undefined }).reason === "retry-after-failure", "G1: a turn with no successful apply behind it retries");
  ok(planEgressApply({ phase: "turn.started", fingerprint: "a", lastApplied: "a", boxPolicyMissing: true }).reason === "box-policy-missing", "OPE-2671: 🔴 an unchanged turn re-applies when this process holds no policy for the session's browser container");
  ok(!planEgressApply({ phase: "turn.started", fingerprint: "a", lastApplied: "a", boxPolicyMissing: false }).reapply, "OPE-2671 negative control: with the policy held, the unchanged turn still skips");

  const p1 = { allow: { "api.acme.test": [{ transform: [{ headers: { authorization: "Bearer OLD" } }] }] } } as never;
  const p2 = { allow: { "api.acme.test": [{ transform: [{ headers: { authorization: "Bearer NEW" } }] }] } } as never;
  ok(egressPolicyFingerprint(p1) !== egressPolicyFingerprint(p2), "G1: rotating the injected credential changes the policy fingerprint (a rotation is DETECTED, though the hosts are identical)");
  ok(egressPolicyFingerprint(p1) === egressPolicyFingerprint(p1), "G1: the fingerprint is stable for an unchanged policy");
  ok(!egressPolicyFingerprint(p1).includes("OLD") && /^[0-9a-f]{64}$/u.test(egressPolicyFingerprint(p1)), "G1: the fingerprint is a bare sha-256 — it never carries the credential it fingerprints");
  ok(egressPolicyFingerprint("deny-all") !== egressPolicyFingerprint("deny-all", "boom"), "G1: a compile-error deny-all never fingerprints the same as a deliberate deny-all");

  const SCOPE = { org: "acme", platform: "slack", workspace: "T1", surface: "C1", principalId: "U7" };
  function rig(compile: () => Promise<unknown>, opts: { trackShape?: boolean } = {}) {
    const applied: unknown[] = [];
    const audits: { action: string; detail: Record<string, unknown> }[] = [];
    const stamps: boolean[] = [];
    let fingerprint: string | undefined;
    let shape: unknown;
    let connectors: string | undefined;
    let failNext = false;
    const deps = {
      resolve: () => access([{ host: "api.acme.test", viaConnection: "acme" }], [conn("acme")]),
      compile: compile as never,
      apply: async (policy: unknown) => {
        if (failNext) throw new Error("sandbox.update blipped");
        applied.push(policy);
      },
      lastApplied: () => fingerprint,
      rememberApplied: (f: string) => {
        fingerprint = f;
      },
      ...(opts.trackShape === false
        ? {}
        : {
            lastEnforcedShape: () => shape,
            rememberEnforcedShape: (v: unknown) => {
              shape = v;
            },
          }),
      lastConnectors: () => connectors,
      rememberConnectors: (c: string) => {
        connectors = c;
      },
      scope: () => SCOPE,
      audit: async (e: { action: string; detail?: Record<string, unknown> }) => {
        audits.push({ action: e.action, detail: e.detail ?? {} });
      },
      stamp: (v: boolean) => {
        stamps.push(v);
      },
    };
    return {
      deps,
      applied,
      audits,
      stamps,
      breakApply: (v: boolean) => {
        failNext = v;
      },
    };
  }

  {
    const r = rig(async () => ({ allow: { "api.acme.test": [] } }));
    let missing = false;
    const deps = { ...r.deps, boxPolicyMissing: () => missing };
    await enforceEgress("session.started", deps as never);
    ok((await enforceEgress("turn.started", deps as never)).reason === "unchanged" && r.applied.length === 1, "OPE-2671 negative control: the policy held in process, an unchanged turn skips");
    missing = true;
    const repush = await enforceEgress("turn.started", deps as never);
    ok(repush.reason === "box-policy-missing" && repush.applied && r.applied.length === 2, "OPE-2671: 🔴 after a restart an unchanged turn re-pushes, so the session's browser container can bind");
  }

  {
    let secret = "OLD";
    const r = rig(async () => ({ allow: { "api.acme.test": [{ transform: [{ headers: { authorization: `Bearer ${secret}` } }] }] } }));
    await enforceEgress("session.started", r.deps as never);
    ok(r.applied.length === 1, "G1: session.started applies the policy");
    ok(r.stamps.length === 1 && r.stamps[0] === true, "G1: a successful session-start apply stamps enforcement true");
    ok(r.audits.filter((a) => a.action === "egress.policy").length === 1, "G1: session.started writes one egress.policy row");
    ok(r.audits.some((a) => a.action === "connector.grant"), "G1: session.started still writes the connector.grant row");

    const unchanged = await enforceEgress("turn.started", r.deps as never);
    ok(r.applied.length === 1, "G1: an UNCHANGED turn makes NO firewall call (skip-unchanged — the steady-state cost is a compile)");
    ok(unchanged.reason === "unchanged" && unchanged.enforced === undefined, "G1: a skipped turn asserts NOTHING about enforcement — it never reached the firewall, so the field is absent rather than a cheerful true");
    ok(r.audits.filter((a) => a.action === "egress.policy").length === 1, "G1: an unchanged turn writes NO audit row (a per-turn 'still the same' would bury the rows that mean something)");

    secret = "ROTATED";
    const rotated = await enforceEgress("turn.started", r.deps as never);
    ok(r.applied.length === 2, "G1: 🔴 a ROTATED CREDENTIAL is re-baked into the firewall on the next turn (the session-grained hole this closes)");
    ok(rotated.reason === "policy-changed", "G1: …and the re-apply names the reason");
    const row = r.audits.filter((a) => a.action === "egress.policy").at(-1)!;
    ok(row.detail.phase === "turn.started" && row.detail.reason === "policy-changed", "G1: the re-apply's audit row carries phase + reason");
    ok(!JSON.stringify(r.audits).includes("ROTATED"), "G1: no audit row ever carries the injected credential");
  }

  {
    const one = { allow: { "a.test": [] } } as never;
    const two = { allow: { "a.test": [], "b.test": [] } } as never;
    const cred = (v: string) => ({ allow: { "a.test": [{ transform: [{ headers: { authorization: `Bearer ${v}` } }] }] } }) as never;
    ok(egressPolicyCovers(egressPolicyShape(one), egressPolicyShape(two)), "OPE-2158: a policy that ADDS a host covers the one in force (a failed widening is staleness)");
    ok(!egressPolicyCovers(egressPolicyShape(two), egressPolicyShape(one)), "OPE-2158: a policy that REMOVES a host does not cover the one in force");
    ok(!egressPolicyCovers(egressPolicyShape(cred("OLD")), egressPolicyShape(cred("NEW"))), "OPE-2158: a changed credential on a shared host does not cover (the code cannot rank two rules)");
    ok(!egressPolicyCovers(egressPolicyShape(one), "deny-all"), "OPE-2158: deny-all never covers an open policy");
    ok(egressPolicyCovers("deny-all", egressPolicyShape(one)), "OPE-2158: anything covers deny-all");
    ok(!egressPolicyCovers(undefined, egressPolicyShape(two)), "OPE-2158: an UNKNOWN in-force shape is never covered");
    ok(!egressPolicyCovers(NEVER_ENFORCED, egressPolicyShape(two)), "OPE-2158: the never-enforced record is not a shape that covers anything");
    ok(!egressPolicyCovers(egressPolicyShape({ allow: { "a.test": [] }, subnets: { allow: ["10.0.0.0/8"] } } as never), egressPolicyShape(two)), "OPE-2158: a changed subnet block does not cover");
    ok(!JSON.stringify(egressPolicyShape(cred("SECRETVALUE"))).includes("SECRETVALUE"), "OPE-2158: the shape holds digests only, never a credential");
  }

  {
    let secret = "OLD";
    const r = rig(async () => ({ allow: { "api.acme.test": [{ transform: [{ headers: { authorization: `Bearer ${secret}` } }] }] } }));
    await enforceEgress("session.started", r.deps as never);
    const stampsAfterStart = r.stamps.length;

    secret = "R1";
    r.breakApply(true);
    const failed = await enforceEgress("turn.started", r.deps as never);
    ok(failed.enforceError !== undefined, "G1: a turn-level apply failure is reported");
    ok(failed.abortError instanceof EgressReapplyRefusedError, "OPE-2158: 🔴 a failed re-apply whose new policy does NOT cover the one in force REFUSES the turn — the old credential would otherwise stay live");
    ok(isTurnEdgeAbort(failed.abortError), "OPE-2158: …and the turn-edge predicate classes that refusal as an abort");
    ok(String(failed.abortError?.message).includes("sandbox.update blipped") && !String(failed.abortError?.message).includes("aborting the session"), "OPE-2158: the refusal names the RAW backend error, not the session-start abort sentence");
    const failRow = r.audits.filter((a) => a.action === "egress.policy").at(-1)!;
    ok(failRow.detail.reapplyFailed === true, "G1: the failed re-apply audits reapplyFailed — the row an incident reader needs (the session is running an OLDER policy than its config says)");
    ok(failRow.detail.aborted === true, "OPE-2158: …and the row records that the turn was refused");
    ok(r.stamps.length === stampsAfterStart, "G1: 🔴 a failed turn re-apply never stamps enforcement FALSE — downgrading it would move checkout_repo onto an in-sandbox token because sandbox.update blipped");

    r.breakApply(false);
    const appliesBefore = r.applied.length;
    const retried = await enforceEgress("turn.started", r.deps as never);
    ok(retried.applied && r.applied.length === appliesBefore + 1, "G1: the next turn RETRIES the same policy (a failed apply deliberately records no fingerprint, so the skip-unchanged gate cannot swallow it)");
    ok(retried.enforced === true && retried.enforceError === undefined && retried.abortError === undefined, "G1: the retry succeeds and the session catches back up to its config");

    secret = "OLD";
    const backToOld = await enforceEgress("turn.started", r.deps as never);
    ok(backToOld.reason === "policy-changed", "G1: reverting to the previously-applied value still re-applies (the last SUCCESS was 'R1', not 'OLD')");
  }

  {
    let hosts: Record<string, unknown[]> = { "api.acme.test": [] };
    const r = rig(async () => ({ allow: hosts }));
    await enforceEgress("session.started", r.deps as never);
    hosts = { "api.acme.test": [], "new.acme.test": [] };
    r.breakApply(true);
    const widened = await enforceEgress("turn.started", r.deps as never);
    ok(widened.enforceError !== undefined && widened.abortError === undefined, "OPE-2158 negative control: a failed re-apply that only ADDS a host continues — the policy in force is narrower, so keeping it is staleness");
  }

  {
    let hosts: Record<string, unknown[]> = { "api.acme.test": [], "revoked.acme.test": [] };
    const r = rig(async () => ({ allow: hosts }));
    await enforceEgress("session.started", r.deps as never);
    hosts = { "api.acme.test": [] };
    r.breakApply(true);
    const narrowed = await enforceEgress("turn.started", r.deps as never);
    ok(narrowed.abortError instanceof EgressReapplyRefusedError, "OPE-2158: 🔴 a REMOVED host whose re-apply fails refuses the turn — the revoked host would otherwise stay open");
  }

  {
    let breakCompile = false;
    const r = rig(async () => {
      if (breakCompile) throw new Error("secretRef ACME_KEY is not set");
      return { allow: { "api.acme.test": [] } };
    });
    await enforceEgress("session.started", r.deps as never);
    breakCompile = true;
    r.breakApply(true);
    const turn = await enforceEgress("turn.started", r.deps as never);
    ok(turn.compileError !== undefined && turn.abortError instanceof EgressReapplyRefusedError, "OPE-2158: a mid-session compile-error deny-all whose apply fails refuses the turn — the open policy would otherwise coast");
  }

  {
    let hosts: Record<string, unknown[]> = { "api.acme.test": [] };
    const r = rig(async () => ({ allow: hosts }), { trackShape: false });
    await enforceEgress("session.started", r.deps as never);
    hosts = { "api.acme.test": [], "new.acme.test": [] };
    r.breakApply(true);
    const unknown = await enforceEgress("turn.started", r.deps as never);
    ok(unknown.abortError instanceof EgressReapplyRefusedError, "OPE-2158: with no recorded in-force shape a failed re-apply cannot be proved staleness, so it refuses");
  }

  {
    overrideSettingsForTest({ egress: { allowUnenforced: true } });
    try {
      let hosts: Record<string, unknown[]> = { "api.acme.test": [], "revoked.acme.test": [] };
      const r = rig(async () => ({ allow: hosts }));
      await enforceEgress("session.started", r.deps as never);
      hosts = { "api.acme.test": [] };
      r.breakApply(true);
      const narrowed = await enforceEgress("turn.started", r.deps as never);
      ok(narrowed.enforced === false && narrowed.abortError instanceof EgressReapplyRefusedError, "OPE-2158: 🔴 egress.allowUnenforced does NOT keep an enforced, wider policy in force after a failed narrowing");

      let hosts2: Record<string, unknown[]> = { "api.acme.test": [], "b.acme.test": [] };
      const never = rig(async () => ({ allow: hosts2 }));
      never.breakApply(true);
      const start = await enforceEgress("session.started", never.deps as never);
      ok(start.enforced === false && start.abortError === undefined, "allowUnenforced: an unenforceable session start still warns and continues");
      hosts2 = { "api.acme.test": [] };
      const turn = await enforceEgress("turn.started", never.deps as never);
      ok(turn.enforced === false && turn.abortError === undefined, "OPE-2158 negative control: a session that NEVER enforced a policy keeps warn-and-continue — refusing would buy nothing");

      let hosts3: Record<string, unknown[]> = { "api.acme.test": [], "revoked.acme.test": [] };
      const justBash = rig(async () => ({ allow: hosts3 }), { trackShape: false });
      justBash.breakApply(true);
      await enforceEgress("session.started", justBash.deps as never);
      hosts3 = { "api.acme.test": [] };
      const unknownTurn = await enforceEgress("turn.started", justBash.deps as never);
      ok(unknownTurn.enforced === false && unknownTurn.abortError === undefined, "OPE-2158: 🔴 under allowUnenforced an unenforcing backend with NO enforced shape on record passes the re-apply (the integration harness's just-bash case)");
    } finally {
      overrideSettingsForTest({ egress: { allowUnenforced: false } });
    }
  }

  {
    const { createHash, createHmac, hkdfSync, randomBytes } = await import("node:crypto");
    const { egressStateDigestKey, egressDigestKeyRotated, EGRESS_STATE_DIGEST_LABEL } = await import("../agent/hooks/egress.js");
    const ENV = "OE_CREDENTIAL_ENCRYPTION_KEY";
    const saved = process.env[ENV];
    const keyA = randomBytes(32);
    const keyB = randomBytes(32);
    const credRules = (v: string) => [{ transform: [{ headers: { authorization: `Bearer ${v}` } }] }];
    const credPolicy = (v: string) => ({ allow: { "api.acme.test": credRules(v) } }) as never;
    const shapeHosts = (s: unknown) => (s as { hosts: Record<string, string> }).hosts;
    const shapeKey = (s: unknown) => (s as { key: string }).key;
    try {
      process.env[ENV] = keyA.toString("base64");

      const shapeA = egressPolicyShape(credPolicy("4711"));
      const unkeyed = createHash("sha256").update(JSON.stringify(credRules("4711"))).digest("hex");
      ok(shapeHosts(shapeA)["api.acme.test"] !== unkeyed, "OPE-2302: 🔴 the per-host digest is NOT the unkeyed sha-256 of the host's rules — the state alone cannot confirm a guess");
      const guesses = Array.from({ length: 10_000 }, (_, i) => String(i).padStart(4, "0"));
      const hit = guesses.find((g) => createHash("sha256").update(JSON.stringify(credRules(g))).digest("hex") === shapeHosts(shapeA)["api.acme.test"]);
      ok(hit === undefined, "OPE-2302: 🔴 an offline dictionary over every 4-digit credential finds NO match without the key");
      ok(egressPolicyShape(credPolicy("4711")) !== undefined && shapeHosts(egressPolicyShape(credPolicy("4711")))["api.acme.test"] === shapeHosts(shapeA)["api.acme.test"], "OPE-2302: the keyed digest is stable under one key, so the coverage comparison still works");

      const subA = Buffer.from(hkdfSync("sha256", keyA, Buffer.alloc(0), "egress-state-digest", 32));
      const expected = createHmac("sha256", subA).update(JSON.stringify(credRules("4711"))).digest("hex");
      ok(EGRESS_STATE_DIGEST_LABEL === "egress-state-digest", "OPE-2302: the HKDF label is `egress-state-digest`");
      ok(shapeHosts(shapeA)["api.acme.test"] === expected, "OPE-2302: the digest is HMAC-SHA256 under HKDF-SHA256(OE_CREDENTIAL_ENCRYPTION_KEY, info=`egress-state-digest`)");
      ok(!subA.equals(keyA), "OPE-2302: the subkey is not the credential key itself");
      ok(egressStateDigestKey().durable && /^[0-9a-f]{16}$/u.test(shapeKey(shapeA)), "OPE-2302: an armed credential key gives a DURABLE digest key, named in the record by a 16-hex id");
      ok(!JSON.stringify(shapeA).includes(keyA.toString("base64")) && !JSON.stringify(shapeA).includes(subA.toString("hex")), "OPE-2302: the record carries neither the credential key nor the subkey");

      process.env[ENV] = keyB.toString("base64");
      const shapeB = egressPolicyShape(credPolicy("4711"));
      ok(shapeHosts(shapeB)["api.acme.test"] !== shapeHosts(shapeA)["api.acme.test"] && shapeKey(shapeB) !== shapeKey(shapeA), "OPE-2302: a rotated credential key changes every digest and the key id");
      ok(!egressPolicyCovers(shapeA, shapeB), "OPE-2302: a shape taken under the OLD key never covers one under the new key — the two cannot be compared");
      ok(egressDigestKeyRotated(shapeA, egressStateDigestKey()), "OPE-2302: the record under the old key reads as ROTATED against the current durable key");
      ok(!egressDigestKeyRotated(shapeB, egressStateDigestKey()), "OPE-2302 negative control: a record under the current key is not rotated");
      ok(!egressDigestKeyRotated("deny-all", egressStateDigestKey()) && !egressDigestKeyRotated(NEVER_ENFORCED, egressStateDigestKey()) && !egressDigestKeyRotated(undefined, egressStateDigestKey()), "OPE-2302: a key-free record (deny-all, never-enforced, unknown) is never rotated");
      const { key: _legacyKey, ...legacy } = shapeB as { key: string };
      ok(egressDigestKeyRotated(legacy as never, egressStateDigestKey()) && !egressPolicyCovers(legacy as never, shapeB), "OPE-2302: a record from before OPE-2302 (no key id) re-applies once and never covers");

      process.env[ENV] = keyA.toString("base64");
      const r = rig(async () => credPolicy("STABLE"));
      await enforceEgress("session.started", r.deps as never);
      const steady = await enforceEgress("turn.started", r.deps as never);
      ok(steady.reason === "unchanged" && r.applied.length === 1, "OPE-2302 negative control: an UNCHANGED key and policy skip the firewall call");

      process.env[ENV] = keyB.toString("base64");
      const rotated = await enforceEgress("turn.started", r.deps as never);
      ok(rotated.reason === "digest-key-rotated" && rotated.applied && r.applied.length === 2, "OPE-2302: 🔴 after a credential-key rotation the hook RE-APPLIES the unchanged policy once");
      const rotRow = r.audits.filter((a) => a.action === "egress.policy").at(-1)!;
      ok(rotRow.detail.reason === "digest-key-rotated", "OPE-2302: …and the audit row names the reason");
      const again = await enforceEgress("turn.started", r.deps as never);
      ok(again.reason === "unchanged" && r.applied.length === 2, "OPE-2302: …exactly ONCE: the next turn skips, because the record is now under the new key");

      process.env[ENV] = keyA.toString("base64");
      r.breakApply(true);
      const failedRot = await enforceEgress("turn.started", r.deps as never);
      ok(failedRot.reason === "digest-key-rotated" && failedRot.enforceError !== undefined && failedRot.abortError === undefined, "OPE-2302: a FAILED rotation re-apply does not refuse the turn — the plan picks it only when the fingerprint equals the one on record, so the turn is no worse off than an unchanged turn");
      r.breakApply(false);
      const retriedRot = await enforceEgress("turn.started", r.deps as never);
      ok(retriedRot.reason === "digest-key-rotated" && retriedRot.enforced === true, "OPE-2302: …and the next turn retries the rotation re-apply");

      process.env[ENV] = keyA.toString("base64");
      const dr = rig(async () => credPolicy("STABLE"));
      await enforceEgress("session.started", dr.deps as never);
      overrideSettingsForTest({ egress: { enforce: false } });
      try {
        process.env[ENV] = keyB.toString("base64");
        const rowsBefore = dr.audits.filter((a) => a.action === "egress.policy").length;
        const d1 = await enforceEgress("turn.started", dr.deps as never);
        const d2 = await enforceEgress("turn.started", dr.deps as never);
        ok(d1.reason === "unchanged" && d2.reason === "unchanged" && dr.audits.filter((a) => a.action === "egress.policy").length === rowsBefore, "OPE-2302 negative control: a rotation in dry-run plans NO re-apply and writes no row, turn after turn");
      } finally {
        overrideSettingsForTest({ egress: { enforce: true } });
      }

      let narrowHosts: Record<string, unknown[]> = { "api.acme.test": [], "revoked.acme.test": [] };
      const n = rig(async () => ({ allow: narrowHosts }));
      await enforceEgress("session.started", n.deps as never);
      process.env[ENV] = keyB.toString("base64");
      narrowHosts = { "api.acme.test": [] };
      n.breakApply(true);
      const narrowRot = await enforceEgress("turn.started", n.deps as never);
      ok(narrowRot.reason === "policy-changed" && narrowRot.abortError instanceof EgressReapplyRefusedError, "OPE-2302: 🔴 a rotation does not soften a failed NARROWING — the turn is still refused");

      delete process.env[ENV];
      const proc = egressStateDigestKey();
      ok(!proc.durable && proc.id.startsWith("process:"), "OPE-2302: with no credential key the digest key is per-PROCESS, and its id says so");
      const shapeP = egressPolicyShape(credPolicy("4711"));
      ok(shapeHosts(shapeP)["api.acme.test"] !== unkeyed, "OPE-2302: 🔴 an unarmed deployment still never records the unkeyed digest");
      const otherProcess = { ...(shapeP as object), key: "process:0000000000000000" } as never;
      ok(!egressDigestKeyRotated(otherProcess, proc), "OPE-2302 negative control: a per-process key never asks for a re-apply (it would repeat on every cold process)");
      ok(!egressPolicyCovers(otherProcess, shapeP), "OPE-2302: …but another process's shape never covers, so a failed narrowing re-apply refuses (fail-closed)");
      const u = rig(async () => credPolicy("STABLE"));
      await enforceEgress("session.started", u.deps as never);
      const uTurn = await enforceEgress("turn.started", u.deps as never);
      ok(uTurn.reason === "unchanged" && u.applied.length === 1, "OPE-2302 negative control: an unarmed deployment's unchanged turn skips as before");
    } finally {
      if (saved === undefined) delete process.env[ENV];
      else process.env[ENV] = saved;
    }
  }

  {
    const refusalAtEdge = (err: unknown, inForce = true): string | undefined => {
      try {
        return handleTurnEdgeFailure(err, inForce)?.reason;
      } catch {
        return "THREW";
      }
    };
    ok(refusalAtEdge(new EgressReapplyRefusedError("x")) === "reapply-narrows-policy-in-force", "OPE-2158: 🔴 the turn.started edge REFUSES a re-apply refusal (and never rethrows it)");
    ok(refusalAtEdge(new WakeSlotWriteError("open-everywhere.halted", new Error("x"))) === "wake-slot-write-failed", "OPE-2157: 🔴 the turn.started edge REFUSES a failed halt-slot write (and never rethrows it)");
    ok(refusalAtEdge(new EgressBindingDivergenceError("x")) === "subagent-binding-divergence", "the turn.started edge still refuses a binding divergence");
    ok(refusalAtEdge(new DelegatedTaskBindingUnavailableError("no-row")) === "delegated-binding-unavailable", "the turn.started edge refuses a delegated binding that did not restore");
    ok(refusalAtEdge(new Error("sandbox.update blipped")) === undefined, "negative control: the turn.started edge swallows a plain plumbing failure while a policy is in force");
    ok(refusalAtEdge(new Error("sandbox.update blipped"), false) === "unenforced-no-policy-in-force", "OPE-2249: 🔴 …but refuses it when NO policy is in force");
    const hookSrc = readFileSync(new URL("../agent/hooks/egress.ts", import.meta.url), "utf8");
    ok(/catch \(err\) \{[\s\S]{0,2000}?const refusal = handleTurnEdgeFailure\(err, inForce\);\s*if \(refusal !== undefined\) await refuseTurn\(/u.test(hookSrc), "the turn.started catch delegates to handleTurnEdgeFailure and cancels on its refusal (the tested body is the wired one)");
  }
  ok(isTurnEdgeAbort(new EgressReapplyRefusedError("x")), "OPE-2158: the turn edge refuses a re-apply refusal");
  ok(isTurnEdgeAbort(new WakeSlotWriteError("open-everywhere.halted", new Error("x"))), "OPE-2157: the turn edge refuses a failed halt-slot write");
  ok(isTurnEdgeAbort(new EgressBindingDivergenceError("x")), "the turn edge still refuses a binding divergence");
  ok(!isTurnEdgeAbort(new Error("sandbox.update blipped")), "negative control: the turn edge swallows a plain plumbing failure");

  {
    const broken = rig(async () => {
      throw new Error("secretRef ACME_KEY is not set");
    });
    await enforceEgress("session.started", broken.deps as never);
    ok(broken.applied[0] === "deny-all", "G1 negative control: a compile failure applies DENY-ALL at session start (unchanged posture)");
    const stillBroken = await enforceEgress("turn.started", broken.deps as never);
    ok(stillBroken.compileError !== undefined && broken.applied.length === 1, "G1 negative control: a still-broken turn stays denied without a redundant firewall call (deny-all is already in force)");
    ok(broken.audits.filter((a) => a.action === "egress.policy").every((a) => typeof a.detail.error === "string"), "G1 negative control: the deny-all row records WHY");
  }
  {
    let breakCompile = false;
    const r = rig(async () => {
      if (breakCompile) throw new Error("secretRef ACME_KEY is not set");
      return { allow: { "api.acme.test": [] } };
    });
    await enforceEgress("session.started", r.deps as never);
    ok(r.applied.length === 1 && r.applied[0] !== "deny-all", "G1 negative control: the session starts on a real compiled policy");
    breakCompile = true;
    const turn = await enforceEgress("turn.started", r.deps as never);
    ok(turn.compileError !== undefined && r.applied[1] === "deny-all", "G1 negative control: 🔴 a bundle that stops compiling MID-SESSION cuts egress off on the next turn — it never coasts on the policy it compiled an hour ago");
    ok(r.audits.filter((a) => a.action === "egress.policy").at(-1)!.detail.error !== undefined, "G1 negative control: the mid-session lockout records WHY");
  }

  {
    overrideSettingsForTest({ egress: { enforce: false } });
    try {
      let secret = "OLD";
      const r = rig(async () => ({ allow: { "api.acme.test": [{ transform: [{ headers: { authorization: `Bearer ${secret}` } }] }] } }));
      await enforceEgress("session.started", r.deps as never);
      ok(r.applied.length === 0, "G1 dry-run: egress.enforce=false still never touches the firewall");
      await enforceEgress("turn.started", r.deps as never);
      ok(r.audits.filter((a) => a.action === "egress.policy").length === 1, "G1 dry-run: an unchanged turn writes NO extra row (the skip gate engages in dry-run too, or a dry-run deployment gets a row every turn)");
      secret = "ROTATED";
      await enforceEgress("turn.started", r.deps as never);
      ok(r.audits.filter((a) => a.action === "egress.policy").length === 2, "G1 dry-run: a CHANGED policy is still reported — dry-run is 'don't apply', not 'don't look'");
    } finally {
      overrideSettingsForTest({ egress: { enforce: true } });
    }
  }

  {
    const r = rig(async () => ({ allow: { "api.acme.test": [] } }));
    r.breakApply(true);
    const aborted = await enforceEgress("session.started", r.deps as never);
    ok(aborted.abortError instanceof Error, "G1: a SESSION-START apply failure still returns an abortError (the hook rethrows it — eve's default is allow-all)");
    ok(r.audits.some((a) => a.action === "egress.policy" && a.detail.aborted === true), "G1: …and the abort is audited BEFORE the throw");
  }
}

{
  const headers = async () => ({ authorization: "Bearer SECRET" });
  const allowOf = (p: unknown): Record<string, unknown> =>
    typeof p === "object" && p !== null ? ((p as { allow?: Record<string, unknown> }).allow ?? {}) : {};

  const withNarrow = await compileNetworkPolicy(
    access(
      [
        { host: "api.acme.test", viaConnection: "acme", methods: ["GET"] },
        { host: "still.acme.test", viaConnection: "kept", methods: ["GET"] },
      ],
      [conn("acme"), conn("kept")],
    ),
    headers,
    async (ids) => ids.filter((id) => id !== "acme"),
  );
  ok(
    !("api.acme.test" in allowOf(withNarrow)),
    "OPE-311(a): a narrowed connection's host is DROPPED from the compiled allow-list (its credential goes with it — there is no entry left to carry one)",
  );
  ok("still.acme.test" in allowOf(withNarrow), "OPE-311(b): an UN-narrowed connection's host is untouched");
  ok(
    rulesFor(withNarrow, "still.acme.test").some((r) => JSON.stringify(r.transform ?? []).includes("SECRET")),
    "OPE-311(b): …and keeps its credential transform (the narrowed host's removal did not take the un-narrowed one's credential with it)",
  );

  const withCredentialless = await compileNetworkPolicy(
    access(
      [
        { host: "docs.acme.test", viaConnection: null },
        { host: "api.acme.test", viaConnection: "acme" },
      ],
      [conn("acme")],
    ),
    headers,
    async () => [],
  );
  ok(
    "docs.acme.test" in allowOf(withCredentialless),
    "OPE-311(c): a credential-less host (bundle.domains) is UNAFFECTED by connector narrowing",
  );
  ok(!("api.acme.test" in allowOf(withCredentialless)), "OPE-311(c): …while the credentialed host compiled alongside it IS narrowed");

  const onStoreFailure = await compileNetworkPolicy(
    access(
      [
        { host: "docs.acme.test", viaConnection: null },
        { host: "api.acme.test", viaConnection: "acme" },
        { host: "still.acme.test", viaConnection: "kept" },
      ],
      [conn("acme"), conn("kept")],
    ),
    headers,
    async () => null,
  );
  ok(typeof onStoreFailure === "object", "OPE-311(d): a store-read failure does not collapse the WHOLE policy to deny-all…");
  ok(
    "docs.acme.test" in allowOf(onStoreFailure),
    "OPE-311(d): …a credential-less host stays reachable even when the override store can't be read",
  );
  ok(
    !("api.acme.test" in allowOf(onStoreFailure)) && !("still.acme.test" in allowOf(onStoreFailure)),
    "🔴 OPE-311(d): EVERY credentialed host is denied on a store-read failure — not just the ones actually revoked (same posture as connector-scope.ts's grantedForCtx null)",
  );

  {
    let calls = 0;
    await compileNetworkPolicy(access([{ host: "docs.acme.test", viaConnection: null }]), headers, async (ids) => {
      calls++;
      return ids;
    });
    ok(calls === 0, "OPE-311(e): the override lookup is skipped entirely when nothing credentialed is in the policy");
  }

  {
    const { narrowByConnectorOverride } = await import("../agent/access/connector-scope.js");
    const { getOperationalStore, registerOperationalStore, resetOperationalStore } = await import("../agent/operational/provider.js");
    type OperationalStore = import("../agent/operational/store.js").OperationalStore;

    const live = getOperationalStore();
    const rows = [{ org: "acme-org", scopeKey: "local/ws1/c1", connector: "acme-conn", granted: false }];
    const seen: { org: string; scopeKey: string }[] = [];
    const fake = {
      ...live,
      connectorOverrides: async (org: string, scopeKey: string) => {
        seen.push({ org, scopeKey });
        return rows.filter((r) => r.org === org && r.scopeKey === scopeKey).map(({ connector, granted }) => ({ connector, granted }));
      },
    } as OperationalStore;
    registerOperationalStore(fake);
    resetOperationalStore();
    _setDeploymentIdentityForTest({ org: "acme-org", workspace: "ws1", surface: "c1" });
    try {
      const narrowed = await narrowByConnectorOverride({}, ["acme-conn", "other-conn"]);
      ok(
        JSON.stringify(narrowed) === JSON.stringify(["other-conn"]),
        "OPE-311(f): narrowByConnectorOverride reads the LIVE store and narrows out the revoked connection id",
      );
      ok(
        seen.length === 1 && seen[0].org === "acme-org" && seen[0].scopeKey === "local/ws1/c1",
        "OPE-311(f): …keyed by the SAME (org, surfaceKey) the credential gate reads — the SAME row a `revoke_connector` approval would have written narrows egress too",
      );

      const compiled = await compileNetworkPolicy(
        access(
          [
            { host: "api.acme.test", viaConnection: "acme-conn" },
            { host: "still.acme.test", viaConnection: "other-conn" },
          ],
          [conn("acme-conn"), conn("other-conn")],
        ),
        headers,
        (ids) => narrowByConnectorOverride({}, ids),
      );
      ok(
        !("api.acme.test" in allowOf(compiled)) && "still.acme.test" in allowOf(compiled),
        "🔴 OPE-311(f) END TO END: a connector_override row shaped exactly like revoke_connector's write removes the revoked host from the compiled sandbox policy — the gap this ticket closes",
      );
    } finally {
      _setDeploymentIdentityForTest({ org: undefined, workspace: undefined, surface: undefined });
      registerOperationalStore(live);
      resetOperationalStore();
    }
  }
}

console.log(
  `\n✓ egress: ${n} assertions passed (pathPrefixes multi-rule + fail-closed policy resolver + abort-on-enforce-failure + capability extra-hosts merge + OPE-1614 browser credential boundary + OPE-300 per-turn re-apply + OPE-311 connector-override reaches egress)\n`,
);

// proves: AP-MOD-core-access-egress, AP-MOD-core-access-extra-hosts

// proves: SET-020, SET-021
