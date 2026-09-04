import assert from "node:assert/strict";
import { compileNetworkPolicy, openWriteHosts, type OpenWriteHost } from "../agent/access/egress.js";
import type { EffectiveAccess, ReachableHost } from "../agent/access/resolver.js";
import type { Connection } from "../agent/access/bundle.js";
import type { AuditInput } from "../agent/audit/audit.js";

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

function access(hosts: ReachableHost[], connections: Connection[] = []): EffectiveAccess {
  return {
    mode: "channel",
    scopeKey: "slack/T1/C1",
    connections,
    connectorCredentials: {},
    reachableHosts: hosts,
    repos: [],
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
  eq(vendor.via, "notion-rest", "🔴 the row NAMES the connection whose rule opened the write — the join ship #159 could not make");
  eq(vendor.methods, ["GET", "PATCH", "POST"], "…and the exact methods it admits, de-duplicated and sorted");

  ok(
    !rows.some((r) => r.host === "api.readonly.test"),
    "🔴 negative control: a GET/HEAD-only host is ABSENT — this is a write report, not a host list",
  );

  const bare = rows.find((r) => r.host === "raw.githubusercontent.com")!;
  eq(bare.via, null, "a credential-less allow is attributed to no connection, which is true of it");
  eq(bare.methods, "any", "🔴 …and a bare allow reports `any`: no method match admits DELETE as readily as GET");
}

{
  const hosts: ReachableHost[] = [{ host: "api.acme.test", viaConnection: "acme" }];
  const rows = openWriteHosts(await compile(hosts), hosts);
  eq(rows.length, 1, "an un-narrowed credentialed host is write-capable");
  eq(rows[0]!.methods, "any", "…reported as `any`, not as an empty method list");
  eq(rows[0]!.via, "acme", "…still attributed to its connection");
}

{
  const hosts: ReachableHost[] = [
    { host: "api.acme.test", viaConnection: "acme", methods: ["GET", "POST"], pathPrefixes: ["/v1/", "/v2/"] },
  ];
  const policy = await compile(hosts);
  eq(((policy as { allow: Record<string, unknown[]> }).allow["api.acme.test"] ?? []).length, 2, "the compiler really emitted one rule per prefix");
  const rows = openWriteHosts(policy, hosts);
  eq(rows.length, 1, "a multi-rule host is reported once");
  eq(rows[0]!.methods, ["GET", "POST"], "…with the union of its rules' methods, not the first rule's");
}

{
  const rows = openWriteHosts(
    { allow: { "api.acme.test": [{ match: { method: ["get"] }, ...bearer }, { match: { method: ["delete"] }, ...bearer }] } } as never,
    [{ host: "api.acme.test", viaConnection: "acme" }],
  );
  eq(rows.length, 1, "a host with any mutating rule is reported even when another rule is read-only");
  eq(rows[0]!.methods, ["DELETE", "GET"], "…methods are upper-cased, so a lower-case declaration cannot hide a DELETE");
}

{
  eq(openWriteHosts("deny-all" as never, []), [] as readonly OpenWriteHost[], "deny-all opens nothing");
  eq(openWriteHosts({} as never, []), [] as readonly OpenWriteHost[], "a policy with no allow map opens nothing");

  const all = openWriteHosts("allow-all" as never, []);
  eq(all.length, 1, "🔴 `allow-all` is NOT silence — the most open policy the type admits must not row as `writeHostCount: 0`");
  eq(all[0]!.host, "*", "…it is reported as the catch-all");
  eq(all[0]!.methods, "any", "…open to every verb");

  const arr = openWriteHosts({ allow: ["b.test", "a.test"] } as never, [{ host: "a.test", viaConnection: "acme" }]);
  eq(
    arr.map((r) => r.host),
    ["a.test", "b.test"],
    "🔴 the bare-array form of `allow` names its HOSTS — `Object.entries` on it would name a host \"0\"",
  );
  eq(arr[0]!.via, "acme", "…still attributed where a reachable host claims it");
  eq(arr[1]!.methods, "any", "…and an array entry carries no rules, so no method narrowing");

  eq(
    openWriteHosts({ allow: { "api.acme.test": [{ match: { method: ["GET"] }, ...bearer }] } } as never),
    [] as readonly OpenWriteHost[],
    "a read-only policy with NO reachable-host list still reports nothing (attribution is optional, the verdict is not)",
  );
  const orphan = openWriteHosts({ allow: { "*": [] } } as never, []);
  eq(orphan.length, 1, "the `networkAccessLevel: \"full\"` catch-all is reported");
  eq(orphan[0]!.via, null, "…with no attribution, because nothing credentialed opened it");
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
    eq(listed[0]!.via, "notion-rest", "🔴 …and the connection that opened it — the whole point of OPE-1445");
    eq(listed[0]!.methods, ["GET", "PATCH", "POST"], "…with the methods it admits");
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
}

console.log(`  ${n} assertions passed`);
