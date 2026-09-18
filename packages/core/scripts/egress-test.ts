import assert from "node:assert/strict";
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
  const { enforceEgress, planEgressApply, egressPolicyFingerprint } = await import("../agent/hooks/egress.js");
  const hook = (await import("../agent/hooks/egress.js")).default as unknown as {
    events: Record<string, unknown>;
  };
  ok(typeof hook.events["turn.started"] === "function", "G1: the egress hook registers a turn.started handler (the re-apply is WIRED, not just written)");
  ok(typeof hook.events["session.started"] === "function", "G1: session.started still registers (the re-apply ADDS an edge, it does not move one)");

  ok(planEgressApply({ phase: "session.started", fingerprint: "a", lastApplied: "a" }).reapply, "G1: session.started ALWAYS applies (eve's session default is allow-all until we narrow it)");
  ok(!planEgressApply({ phase: "turn.started", fingerprint: "a", lastApplied: "a" }).reapply, "G1: a turn whose policy is unchanged skips the firewall call");
  ok(planEgressApply({ phase: "turn.started", fingerprint: "b", lastApplied: "a" }).reapply, "G1: a turn whose policy CHANGED re-applies");
  ok(planEgressApply({ phase: "turn.started", fingerprint: "a", lastApplied: undefined }).reason === "retry-after-failure", "G1: a turn with no successful apply behind it retries");

  const p1 = { allow: { "api.acme.test": [{ transform: [{ headers: { authorization: "Bearer OLD" } }] }] } } as never;
  const p2 = { allow: { "api.acme.test": [{ transform: [{ headers: { authorization: "Bearer NEW" } }] }] } } as never;
  ok(egressPolicyFingerprint(p1) !== egressPolicyFingerprint(p2), "G1: rotating the injected credential changes the policy fingerprint (a rotation is DETECTED, though the hosts are identical)");
  ok(egressPolicyFingerprint(p1) === egressPolicyFingerprint(p1), "G1: the fingerprint is stable for an unchanged policy");
  ok(!egressPolicyFingerprint(p1).includes("OLD") && /^[0-9a-f]{64}$/u.test(egressPolicyFingerprint(p1)), "G1: the fingerprint is a bare sha-256 — it never carries the credential it fingerprints");
  ok(egressPolicyFingerprint("deny-all") !== egressPolicyFingerprint("deny-all", "boom"), "G1: a compile-error deny-all never fingerprints the same as a deliberate deny-all");

  const SCOPE = { org: "acme", platform: "slack", workspace: "T1", surface: "C1", principalId: "U7" };
  function rig(compile: () => Promise<unknown>) {
    const applied: unknown[] = [];
    const audits: { action: string; detail: Record<string, unknown> }[] = [];
    const stamps: boolean[] = [];
    let fingerprint: string | undefined;
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
    let secret = "OLD";
    const r = rig(async () => ({ allow: { "api.acme.test": [{ transform: [{ headers: { authorization: `Bearer ${secret}` } }] }] } }));
    await enforceEgress("session.started", r.deps as never);
    const stampsAfterStart = r.stamps.length;

    secret = "R1";
    r.breakApply(true);
    const failed = await enforceEgress("turn.started", r.deps as never);
    ok(failed.enforceError !== undefined && failed.abortError === undefined, "G1: a turn-level apply failure is reported, NOT thrown (the session-start policy is still in force)");
    const failRow = r.audits.filter((a) => a.action === "egress.policy").at(-1)!;
    ok(failRow.detail.reapplyFailed === true, "G1: the failed re-apply audits reapplyFailed — the row an incident reader needs (the session is running an OLDER policy than its config says)");
    ok(r.stamps.length === stampsAfterStart, "G1: 🔴 a failed turn re-apply never stamps enforcement FALSE — downgrading it would move checkout_repo onto an in-sandbox token because sandbox.update blipped");

    r.breakApply(false);
    const appliesBefore = r.applied.length;
    const retried = await enforceEgress("turn.started", r.deps as never);
    ok(retried.applied && r.applied.length === appliesBefore + 1, "G1: the next turn RETRIES the same policy (a failed apply deliberately records no fingerprint, so the skip-unchanged gate cannot swallow it)");
    ok(retried.enforced === true && retried.enforceError === undefined, "G1: the retry succeeds and the session catches back up to its config");

    secret = "OLD";
    const backToOld = await enforceEgress("turn.started", r.deps as never);
    ok(backToOld.reason === "policy-changed", "G1: reverting to the previously-applied value still re-applies (the last SUCCESS was 'R1', not 'OLD')");
  }

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
