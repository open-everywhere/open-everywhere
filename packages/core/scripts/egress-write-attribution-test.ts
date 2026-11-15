// proves: egress.hostside.allow

import assert from "node:assert/strict";
import { compileNetworkPolicy, openWriteHosts, type OpenWriteHost } from "../agent/access/egress.js";
import type { EffectiveAccess, ReachableHost } from "../agent/access/resolver.js";
import type { Connection } from "../agent/access/bundle.js";
import type { AuditInput } from "../agent/audit/audit.js";

import { pinSuiteStore } from "./_suite-store.js";
pinSuiteStore("egress-write-attribution");

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

console.log("egress write attribution (OPE-1445):");

const SECRET = "sk-oe-egress-writeattr-canary-4c81";
const bearer = { transform: [{ headers: { authorization: `Bearer ${SECRET}` } }] };

const conn = (id: string): Connection =>
  ({ id, credentialType: "bearer", secretRef: "ACME_KEY", allowedWebsites: ["api.acme.test"] }) as unknown as Connection;

function access(hosts: ReachableHost[], connections: Connection[] = [], repos: string[] = []): EffectiveAccess {
  return {
    mode: "channel",
    scopeKey: "slack/T1/C1",
    connections,
    connectorCredentials: {},
    reachableHosts: hosts,
    repos,
    repoCapabilities: {},
    resourceCapabilities: {},
    plugins: [],
    skills: [],
    subagents: [],
    connectors: [],
    connectorContentOrigin: {},
    instructionStack: [],
    preApprovalRules: [],
    warnings: [],
  } as unknown as EffectiveAccess;
}

const compile = (hosts: ReachableHost[], connections: Connection[] = [conn("notion-rest"), conn("acme")]) =>
  compileNetworkPolicy(
    access(hosts, connections),
    async () => ({ authorization: `Bearer ${SECRET}` }),
    async (ids) => ids,
  );

{
  const hosts: ReachableHost[] = [
    { host: "api.vendor.test", viaConnection: "notion-rest", methods: ["GET", "POST", "PATCH"] },
    { host: "api.readonly.test", viaConnection: "acme", methods: ["GET", "HEAD"] },
    { host: "raw.githubusercontent.com", viaConnection: null },
  ];
  const policy = await compile(hosts);

  const rows = openWriteHosts(policy, hosts);
  ok(rows.length === 2, "only the hosts open to a mutating verb are reported");
  eq(
    rows.map((r) => r.host),
    ["api.vendor.test", "raw.githubusercontent.com"],
    "…sorted by host, so two rows for one policy generation compare byte-for-byte",
  );

  const vendor = rows.find((r) => r.host === "api.vendor.test")!;
  eq(vendor.credential, "notion-rest", "🔴 the row NAMES the connection whose rule opened the write — the join a live run could not make");
  eq(vendor.credentialed, true, "…and says a credential really rides on it");
  eq(vendor.verb, ["GET", "PATCH", "POST"], "…and the exact methods it admits, de-duplicated and sorted");

  ok(
    !rows.some((r) => r.host === "api.readonly.test"),
    "🔴 negative control: a GET/HEAD-only host is ABSENT — this is a write report, not a host list",
  );

  const bare = rows.find((r) => r.host === "raw.githubusercontent.com")!;
  eq(bare.credential, null, "a credential-less allow is attributed to no connection, which is true of it");
  eq(bare.credentialed, false, "…and says so positively, rather than leaving the reader to infer it from a null");
  eq(bare.verb, "any", "🔴 …and a bare allow reports `any`: no method match admits DELETE as readily as GET");
}

{
  const hosts: ReachableHost[] = [{ host: "github.com", viaConnection: "gh-app", methods: ["GET", "POST"] }];
  const conns = [conn("gh-app")];

  const grantedPolicy = await compileNetworkPolicy(
    access(hosts, conns, ["acme/widgets"]),
    async () => ({ authorization: `Bearer ${SECRET}` }),
    async (ids) => ids,
  );
  const grantedRow = openWriteHosts(grantedPolicy, hosts).find((r) => r.host === "github.com")!;
  eq(grantedRow.credential, "gh-app", "🔴 positive control: with the grant intact, github.com IS attributed to its connection");
  eq(grantedRow.credentialed, true, "…and the row says a credential rides");

  const revokedPolicy = await compileNetworkPolicy(
    access(hosts, conns, ["acme/widgets"]),
    async () => ({ authorization: `Bearer ${SECRET}` }),
    async () => [],
  );
  eq(
    (revokedPolicy as { allow: Record<string, unknown[]> }).allow["github.com"],
    [],
    "the compiler re-added github.com as a bare allow after the revoke dropped its credentialed rule",
  );
  ok(!JSON.stringify(revokedPolicy).includes(SECRET), "…and the revoked credential is not in the policy at all");

  const revokedRow = openWriteHosts(revokedPolicy, hosts).find((r) => r.host === "github.com")!;
  ok(revokedRow !== undefined, "the re-added host is still reported as write-open — the reach is real, only the attribution was wrong");
  eq(
    revokedRow.credential,
    null,
    "🔴 OPE-1448: a host the policy stamps NOTHING on names no connection — a revoked credential must never read as still injected",
  );
  eq(revokedRow.credentialed, false, "…and the row states the absence positively");
  eq(revokedRow.verb, "any", "…while still reporting the bare allow's full verb reach");
}

{
  const { mergeGitReadBroker } = await import("../agent/scm/broker.js");
  const { brokerAttributionHosts } = await import("../agent/scm/broker-audit.js");
  const brokered = mergeGitReadBroker(
    { allow: {} } as never,
    new Map([["acme", { match: { path: { startsWith: "/acme/" } }, transform: [{ headers: { Authorization: `Basic ${SECRET}` } }] }]]),
  );

  const bundleClaims: ReachableHost[] = [{ host: "github.com", viaConnection: "gh-conn", methods: ["GET"] }];

  const unfiltered = openWriteHosts(brokered, bundleClaims).find((r) => r.host === "github.com")!;
  eq(unfiltered.credential, "gh-conn", "positive control: attribution is a host-NAME lookup — an unfiltered list really does name the bundle connection");

  const rows = openWriteHosts(brokered, brokerAttributionHosts(bundleClaims));
  eq(rows.map((r) => r.host), ["codeload.github.com", "github.com"], "both brokered git hosts are reported");
  const gh = rows.find((r) => r.host === "github.com")!;
  eq(gh.credentialed, true, "🔴 a brokered host says a credential rides, though no bundle connection named it");
  eq(
    gh.credential,
    null,
    "🔴 …and names none: the broker REPLACED the bundle's github.com rule, so naming that connection would report a credential that is not the one riding",
  );
  eq(gh.verb, "any", "🔴 the broker's rule declares no method match, so it is open to every verb");
  ok(!JSON.stringify(rows).includes(SECRET), "…and the brokered token does not reach the row");

  eq(
    brokerAttributionHosts([...bundleClaims, { host: "api.acme.test", viaConnection: "acme" }]).map((h) => h.host),
    ["api.acme.test"],
    "🔴 negative control: brokerAttributionHosts drops ONLY the hosts the broker replaces",
  );
}

{
  const headerless = { allow: { "api.acme.test": [{ transform: [{}] }] } } as never;

  const rows = openWriteHosts(headerless, [{ host: "api.acme.test", viaConnection: "acme" }]);
  eq(rows[0]!.credentialed, true, "🔴 a transform entry with no headers still reads as credentialed — unrecognised shapes err toward MORE open");
  eq(rows[0]!.credential, "acme", "…and is attributed, because something is stamped");

  const { summariseEgressPolicy } = await import("../agent/access/egress-status.js");
  const entry = summariseEgressPolicy(headerless).allow.find((a) => a.host === "api.acme.test")!;
  eq(entry.credentialInjected, true, "🔴 STATUS.json reads the SAME headerless transform the same way");
  eq(
    entry.credentialInjected,
    rows[0]!.credentialed,
    "🔴 one policy, one answer: the audit row and the in-sandbox status file never disagree about whether a credential rides",
  );

  const bare = { allow: { "api.acme.test": [] } } as never;
  const bareRow = openWriteHosts(bare, [{ host: "api.acme.test", viaConnection: "acme" }])[0]!;
  const bareEntry = summariseEgressPolicy(bare).allow.find((a) => a.host === "api.acme.test")!;
  eq(bareRow.credentialed, false, "a bare allow stamps nothing…");
  eq(bareEntry.credentialInjected, false, "…on both surfaces");
}

{
  const hosts: ReachableHost[] = [{ host: "api.acme.test", viaConnection: "acme" }];
  const rows = openWriteHosts(await compile(hosts), hosts);
  eq(rows.length, 1, "an un-narrowed credentialed host is write-capable");
  eq(rows[0]!.verb, "any", "…reported as `any`, not as an empty method list");
  eq(rows[0]!.credential, "acme", "…still attributed to its connection");
}

{
  const hosts: ReachableHost[] = [
    { host: "api.acme.test", viaConnection: "acme", methods: ["GET", "POST"], pathPrefixes: ["/v1/", "/v2/"] },
  ];
  const policy = await compile(hosts);
  eq(((policy as { allow: Record<string, unknown[]> }).allow["api.acme.test"] ?? []).length, 2, "the compiler really emitted one rule per prefix");
  const rows = openWriteHosts(policy, hosts);
  eq(rows.length, 1, "a multi-rule host is reported once");
  eq(rows[0]!.verb, ["GET", "POST"], "…with the union of its rules' methods, not the first rule's");
}

{
  const rows = openWriteHosts(
    { allow: { "api.acme.test": [{ match: { method: ["get"] }, ...bearer }, { match: { method: ["delete"] }, ...bearer }] } } as never,
    [{ host: "api.acme.test", viaConnection: "acme" }],
  );
  eq(rows.length, 1, "a host with any mutating rule is reported even when another rule is read-only");
  eq(rows[0]!.verb, ["DELETE", "GET"], "…methods are upper-cased, so a lower-case declaration cannot hide a DELETE");
}

{
  eq(openWriteHosts("deny-all" as never, []), [] as readonly OpenWriteHost[], "deny-all opens nothing");
  eq(openWriteHosts({} as never, []), [] as readonly OpenWriteHost[], "a policy with no allow map opens nothing");

  const all = openWriteHosts("allow-all" as never, []);
  eq(all.length, 1, "🔴 `allow-all` is NOT silence — the most open policy the type admits must not row as `writeHostCount: 0`");
  eq(all[0]!.host, "*", "…it is reported as the catch-all");
  eq(all[0]!.verb, "any", "…open to every verb");

  const arr = openWriteHosts({ allow: ["b.test", "a.test"] } as never, [{ host: "a.test", viaConnection: "acme" }]);
  eq(
    arr.map((r) => r.host),
    ["a.test", "b.test"],
    "🔴 the bare-array form of `allow` names its HOSTS — `Object.entries` on it would name a host \"0\"",
  );
  eq(arr[0]!.credential, null, "an array entry stamps nothing, so it names no connection even where the config wished for one");
  eq(arr[0]!.credentialed, false, "…and says so");
  eq(arr[1]!.verb, "any", "…and an array entry carries no rules, so no method narrowing");

  eq(
    openWriteHosts({ allow: { "api.acme.test": [{ match: { method: ["GET"] }, ...bearer }] } } as never),
    [] as readonly OpenWriteHost[],
    "a read-only policy with NO reachable-host list still reports nothing (attribution is optional, the verdict is not)",
  );
  const orphan = openWriteHosts({ allow: { "*": [] } } as never, []);
  eq(orphan.length, 1, "the `networkAccessLevel: \"full\"` catch-all is reported");
  eq(orphan[0]!.credential, null, "…with no attribution, because nothing credentialed opened it");
  eq(orphan[0]!.credentialed, false, "…and it stamps nothing");
  eq(all[0]!.credentialed, false, "`allow-all` is reach without a credential, and the row separates the two");
}

{
  const hosts: ReachableHost[] = [{ host: "api.acme.test", viaConnection: "acme", methods: ["GET", "POST"] }];
  const policy = await compile(hosts);
  ok(JSON.stringify(policy).includes(SECRET), "🔴 positive control: the COMPILED policy really carries the canary credential");

  const rows = openWriteHosts(policy, hosts);
  const bytes = JSON.stringify(rows);
  ok(rows.length === 1, "…and the host it credentials is reported");
  ok(!bytes.includes(SECRET), "🔴 the rendered rows carry no credential value — an assertion about the OUTPUT, not about intent");
  ok(!bytes.includes("authorization"), "…and no transform field at all reaches the row");
}

{
  const { enforceEgress } = await import("../agent/hooks/egress.js");

  const SCOPE = { org: "acme", platform: "slack", workspace: "T1", surface: "C1", principalId: "U7" };

  function rig(hosts: ReachableHost[], policy: unknown) {
    const rows: AuditInput[] = [];
    let fingerprint: string | undefined;
    let connectors: string | undefined;
    const deps = {
      resolve: () => access(hosts, [conn("notion-rest")]),
      compile: async () => policy,
      apply: async () => {},
      lastApplied: () => fingerprint,
      rememberApplied: (f: string) => {
        fingerprint = f;
      },
      lastConnectors: () => connectors,
      rememberConnectors: (c: string) => {
        connectors = c;
      },
      scope: () => SCOPE,
      audit: async (row: AuditInput) => {
        rows.push(row);
      },
      stamp: () => {},
    };
    return { deps, rows };
  }

  {
    const hosts: ReachableHost[] = [{ host: "api.vendor.test", viaConnection: "notion-rest", methods: ["GET", "POST", "PATCH"] }];
    const policy = await compile(hosts);
    ok(JSON.stringify(policy).includes(SECRET), "🔴 positive control: the policy this pass applies really carries the canary");
    const r = rig(hosts, policy);
    await enforceEgress("session.started", r.deps as never);

    const row = r.rows.find((x) => x.action === "egress.policy");
    ok(row !== undefined, "the pass appends an egress.policy row");
    const detail = row!.detail as Record<string, unknown>;
    eq(detail.writeHostCount, 1, "🔴 the ROW carries the write-capable count — the derivation is actually reached");
    const listed = detail.writeHosts as OpenWriteHost[];
    ok(Array.isArray(listed) && listed.length === 1, "…and the list itself");
    eq(listed[0]!.host, "api.vendor.test", "🔴 the row NAMES the host that was open to a write");
    eq(listed[0]!.credential, "notion-rest", "🔴 …and the connection that opened it — the whole point of OPE-1445");
    eq(listed[0]!.credentialed, true, "…and that a credential really rides on it");
    eq(listed[0]!.verb, ["GET", "PATCH", "POST"], "…with the methods it admits");
    ok(!JSON.stringify(row).includes(SECRET), "🔴 end-to-end: the audited row carries no credential value");
    ok(detail.writeHostsTruncated === undefined, "a short list is not marked truncated");
  }

  {
    const hosts: ReachableHost[] = [{ host: "api.vendor.test", viaConnection: "notion-rest", methods: ["GET"] }];
    const r = rig(hosts, await compile(hosts));
    await enforceEgress("session.started", r.deps as never);
    const detail = r.rows.find((x) => x.action === "egress.policy")!.detail as Record<string, unknown>;
    eq(detail.writeHostCount, 0, "🔴 negative control: a read-only policy rows `writeHostCount: 0`");
    eq(detail.writeHosts, undefined, "…and carries no list to read");
  }

  {
    const many = Array.from({ length: 25 }, (_, i) => `api.h${String(i).padStart(2, "0")}.test`);
    const hosts = many.map((host) => ({ host, viaConnection: "notion-rest", methods: ["POST"] }) as ReachableHost);
    const r = rig(hosts, await compile(hosts));
    await enforceEgress("session.started", r.deps as never);
    const detail = r.rows.find((x) => x.action === "egress.policy")!.detail as Record<string, unknown>;
    eq(detail.writeHostCount, 25, "the COUNT is exact even past the cap — an auditor is never told a smaller number");
    eq((detail.writeHosts as unknown[]).length, 20, "…while the listed rows stay bounded");
    eq(detail.writeHostsTruncated, true, "…and the row says it was cut, so the gap is not silent");
  }

  {
    const rows: AuditInput[] = [];
    const deps = {
      resolve: () => {
        throw new Error("bundle load failed");
      },
      compile: async () => ({ allow: {} }),
      apply: async () => {},
      lastApplied: () => undefined,
      rememberApplied: () => {},
      lastConnectors: () => undefined,
      rememberConnectors: () => {},
      scope: () => SCOPE,
      audit: async (row: AuditInput) => {
        rows.push(row);
      },
      stamp: () => {},
    };
    await enforceEgress("session.started", deps as never);
    const detail = rows.find((x) => x.action === "egress.policy")!.detail as Record<string, unknown>;
    eq(detail.writeHostCount, 0, "a compile failure opens nothing, and the row says so rather than omitting the field");
    ok(typeof detail.error === "string", "…alongside the compile error that caused the deny-all");
  }

  {
    const diverging = (hosts: ReachableHost[], policy: unknown) => {
      const r = rig(hosts, policy);
      return { ...r, deps: { ...r.deps, parentPublishedFingerprint: async () => "parent-published-something-else" } };
    };

    {
      const hosts: ReachableHost[] = [{ host: "api.vendor.test", viaConnection: "notion-rest", methods: ["POST"] }];
      const policy = await compile(hosts);
      ok(JSON.stringify(policy).includes(SECRET), "🔴 positive control: the REFUSED child's policy really carries the canary");
      const r = diverging(hosts, policy);
      const out = await enforceEgress("turn.started", r.deps as never);

      ok(out.abortError instanceof Error, "positive control: the child really was aborted — this is the abort path, not the ordinary one");
      const row = r.rows.find((x) => x.action === "egress.policy");
      ok(row !== undefined, "the abort appends its own egress.policy row");
      const detail = row!.detail as Record<string, unknown>;
      eq(detail.reason, "subagent-binding-divergence", "…and it is the DIVERGENCE row, not an ordinary apply row");
      eq(detail.aborted, true, "…marked as an abort");
      eq(detail.writeHostCount, 1, "🔴 the abort row carries the write-capable count of the policy it REFUSED");
      const listed = detail.writeHosts as OpenWriteHost[];
      ok(Array.isArray(listed) && listed.length === 1, "…and the list itself");
      eq(listed[0]!.host, "api.vendor.test", "🔴 naming the host the refused child would have left open to a write");
      eq(listed[0]!.credential, "notion-rest", "🔴 …and the connection that would have opened it");
      eq(listed[0]!.credentialed, true, "…with a credential stamped on it");
      ok(!JSON.stringify(row).includes(SECRET), "🔴 the abort row carries no credential value either");
    }

    {
      const hosts: ReachableHost[] = [{ host: "api.vendor.test", viaConnection: "notion-rest", methods: ["GET"] }];
      const r = diverging(hosts, await compile(hosts));
      await enforceEgress("turn.started", r.deps as never);
      const detail = r.rows.find((x) => x.action === "egress.policy")!.detail as Record<string, unknown>;
      eq(detail.reason, "subagent-binding-divergence", "the negative control is on the abort row too");
      eq(detail.writeHostCount, 0, "🔴 negative control: a read-only child policy aborts with `writeHostCount: 0`");
      eq(detail.writeHosts, undefined, "…and carries no list");
    }

    {
      const hosts: ReachableHost[] = [{ host: "api.vendor.test", viaConnection: "notion-rest", methods: ["POST"] }];
      const policy = await compile(hosts);
      const { egressPolicyFingerprint } = await import("../agent/hooks/egress.js");
      const r = rig(hosts, policy);
      const deps = { ...r.deps, parentPublishedFingerprint: async () => egressPolicyFingerprint(policy as never) };
      const out = await enforceEgress("turn.started", deps as never);
      ok(out.abortError === undefined, "a child matching its parent is not aborted");
      ok(
        r.rows.every((x) => (x.detail as Record<string, unknown>)?.reason !== "subagent-binding-divergence"),
        "🔴 …and writes no divergence row — the row is the abort's own, not a field every pass carries",
      );
    }
  }
}

{
  console.log("  §4 the cross-plane row contract (OPE-1547):");
  const { EGRESS_AUDIT_ROW_FIELDS, hostCallAuditFields, writeHostsAuditFields } = await import("../agent/access/egress.js");

  const sandboxHosts: ReachableHost[] = [
    { host: "api.vendor.test", viaConnection: "notion-rest", methods: ["GET", "POST", "PATCH"] },
  ];
  const sandboxPolicy = await compile(sandboxHosts);
  ok(JSON.stringify(sandboxPolicy).includes(SECRET), "🔴 positive control: the compiled policy really carries the canary credential");
  const sandboxFields = writeHostsAuditFields(openWriteHosts(sandboxPolicy, sandboxHosts));
  const sandboxRow = (sandboxFields.writeHosts as Record<string, unknown>[])[0]!;
  eq(sandboxRow.plane, "sandbox", "the sandbox plane's entry names its plane");
  eq(sandboxRow.unit, "policy", "🔴 …and its UNIT: one host one firewall apply left open, never a call anybody observed");
  eq(sandboxRow.outcome, "granted", "🔴 …so its outcome is `granted` — this plane cannot report a call's fate");
  eq(sandboxRow.host, "api.vendor.test", "…the target host");
  eq(sandboxRow.verb, ["GET", "PATCH", "POST"], "…the verbs it admits, under the SHARED name `verb`");
  eq(sandboxRow.credential, "notion-rest", "🔴 …and the credential IDENTITY, under the shared name `credential`");
  ok(!JSON.stringify(sandboxRow).includes(SECRET), "🔴 …carrying no byte of the credential VALUE");

  await import("./_register-test-config.js");
  const {
    _resetDeploymentIdentityForTest,
    _setDeploymentIdentityForTest,
    registerDeploymentIdentity,
    registeredDeploymentIdentity,
  } = await import("../agent/identity/deployment-identity.js");
  const savedIdentity = registeredDeploymentIdentity();
  _setDeploymentIdentityForTest({ org: "acme-org", workspace: "ws1", surface: "c1" });
  const { oeFetch, setHostEgressLookup } = await import("../agent/access/host-egress.js");
  const { getOperationalStore, registerOperationalStore, resetOperationalStore } = await import("../agent/operational/provider.js");
  type OperationalStore = import("../agent/operational/store.js").OperationalStore;
  type BindableContext = import("../agent/identity/binding.js").BindableContext;

  const PROXY_VARS = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"] as const;
  const savedProxyEnv = PROXY_VARS.map((k) => [k, process.env[k]] as const);
  for (const k of PROXY_VARS) delete process.env[k];

  const realFetch = globalThis.fetch;
  const live = getOperationalStore();
  type CapturedRow = { action: string; org?: string; workspace?: string; surface?: string; detail?: Record<string, unknown> };
  const hostRows: CapturedRow[] = [];
  const sentInits: (RequestInit | undefined)[] = [];
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    sentInits.push(init);
    return new Response("stub", { status: 200 });
  }) as typeof globalThis.fetch;
  registerOperationalStore({
    ...live,
    appendAudit: async (r: CapturedRow) => void hostRows.push(r),
  } as unknown as OperationalStore);
  resetOperationalStore();
  setHostEgressLookup(async () => ["93.184.216.34"]);

  let hostRow: Record<string, unknown>;
  try {
    const res = await oeFetch({} as BindableContext, "https://raw.githubusercontent.com/o/r/main/README.md", {
      tool: "describe_image",
    });
    ok(res.status === 200, "positive control: the stubbed dispatch really returned, so the row below describes a settled call");
    const allow = hostRows.filter((r) => r.action === "egress.hostside.allow").at(-1);
    ok(allow !== undefined, "🔴 an allowed host-side call appends exactly one `egress.hostside.allow` row");
    hostRow = allow!.detail as Record<string, unknown>;

    eq(allow!.org, "acme-org", "🔴 the host-side row is stamped with the DECLARED org");
    eq(allow!.workspace, "ws1", "🔴 …the declared ambient workspace");
    eq(allow!.surface, "c1", "🔴 …and the declared ambient surface");

    sentInits.length = 0;
    await oeFetch({} as BindableContext, "https://raw.githubusercontent.com/o/r/main/README.md", {
      tool: "describe_image",
      method: "DELETE",
    } as unknown as Parameters<typeof oeFetch>[2]);
    eq(sentInits.length, 1, "positive control: the forced call really reached the stubbed socket exactly once");
    eq(sentInits.at(-1)!.method, undefined, "🔴 a caller-supplied verb never reaches the socket — oeFetch sets no `method`, so the dispatch is a GET");
    const forced = hostRows.filter((r) => r.action === "egress.hostside.allow").at(-1)!.detail as Record<string, unknown>;
    eq(forced.verb, ["GET"], "🔴 …and the row reports the plane's constant verb, never one a caller asked for");
  } finally {
    setHostEgressLookup(undefined);
    globalThis.fetch = realFetch;
    registerOperationalStore(live);
    resetOperationalStore();
    if (savedIdentity) registerDeploymentIdentity(savedIdentity);
    else _resetDeploymentIdentityForTest();
    for (const [k, v] of savedProxyEnv) if (v !== undefined) process.env[k] = v;
  }
  eq(hostRow.plane, "host", "the host plane's row names its plane");
  eq(hostRow.unit, "call", "🔴 …and its UNIT: one row per call, because this plane makes the call");
  eq(hostRow.outcome, "allowed", "🔴 …and the OUTCOME, which the row could not carry before OPE-1547");
  eq(hostRow.host, "raw.githubusercontent.com", "…the target host");
  eq(hostRow.verb, ["GET"], "🔴 …the VERB it sent, under the same shared name the sandbox plane uses");
  eq(hostRow.credential, null, "🔴 …and `credential: null` as a POSITIVE claim: oeFetch attaches nothing to a model-supplied URL");
  eq(hostRow.route, "direct", "🔴 the dispatch route is `route` — `via` now means the credential identity on both planes");
  ok(hostRow.via === undefined, "🔴 …and `via` is GONE from the host row, so one name cannot mean two things in one store");

  for (const field of EGRESS_AUDIT_ROW_FIELDS) {
    ok(sandboxRow[field] !== undefined, `🔴 the SANDBOX plane's row carries the shared field \`${field}\``);
    ok(hostRow[field] !== undefined || (field === "credential" && "credential" in hostRow), `🔴 the HOST plane's row carries the shared field \`${field}\``);
  }

  const credentialed = hostCallAuditFields({
    host: "files.slack.com",
    verb: "GET",
    outcome: "allowed",
    credential: "SLACK_BOT_TOKEN",
  });
  eq(credentialed.credential, "SLACK_BOT_TOKEN", "🔴 a credentialed host-side call names the credential REF — the identity, never the secret");
  eq(credentialed.plane, "host", "…on the host plane");
  eq(credentialed.unit, "call", "…at call unit");
  for (const field of EGRESS_AUDIT_ROW_FIELDS) {
    ok(credentialed[field] !== undefined, `🔴 the credentialed host-side row carries the shared field \`${field}\``);
  }
}

console.log(`  ${n} assertions passed`);
