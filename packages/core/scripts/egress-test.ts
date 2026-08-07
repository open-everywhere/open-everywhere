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
    ok(unchanged.reason === "unchanged" && unchanged.enforced, "G1: the skipped turn still reports enforced (the standing policy is what enforces it)");
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
    ok(retried.enforced && retried.enforceError === undefined, "G1: the retry succeeds and the session catches back up to its config");

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
    process.env.OE_EGRESS_ENFORCE = "0";
    try {
      let secret = "OLD";
      const r = rig(async () => ({ allow: { "api.acme.test": [{ transform: [{ headers: { authorization: `Bearer ${secret}` } }] }] } }));
      await enforceEgress("session.started", r.deps as never);
      ok(r.applied.length === 0, "G1 dry-run: OE_EGRESS_ENFORCE=0 still never touches the firewall");
      await enforceEgress("turn.started", r.deps as never);
      ok(r.audits.filter((a) => a.action === "egress.policy").length === 1, "G1 dry-run: an unchanged turn writes NO extra row (the skip gate engages in dry-run too, or a dry-run deployment gets a row every turn)");
      secret = "ROTATED";
      await enforceEgress("turn.started", r.deps as never);
      ok(r.audits.filter((a) => a.action === "egress.policy").length === 2, "G1 dry-run: a CHANGED policy is still reported — dry-run is 'don't apply', not 'don't look'");
    } finally {
      delete process.env.OE_EGRESS_ENFORCE;
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

console.log(`\n✓ egress: ${n} assertions passed (pathPrefixes multi-rule + fail-closed policy resolver + abort-on-enforce-failure + capability extra-hosts merge + OPE-300 per-turn re-apply)\n`);
