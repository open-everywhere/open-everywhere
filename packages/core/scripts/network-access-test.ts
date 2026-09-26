import assert from "node:assert/strict";
import {
  resolveNetworkAccessLevel,
  assertNetworkAccessValid,
  defineNetworkAccess,
  DEFAULT_NETWORK_ACCESS_LEVEL,
  TRUSTED_ACCESS_HOSTS,
  TRUSTED_ACCESS_DEVELOPER_HOSTS,
  type NetworkAccessBinding,
} from "../agent/access/network-access.js";
import { compileNetworkPolicy } from "../agent/access/egress.js";
import { PACKAGE_REGISTRY_HOSTS, type Connection } from "../agent/access/bundle.js";
import type { EffectiveAccess, ReachableHost } from "../agent/access/resolver.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

{
  const chan = (tenantKey: string, surfaceKey: string, domains: string[] = []) =>
    ({ mode: "channel" as const, tenantKey, surfaceKey, domains });
  const dm = { mode: "dm" as const, tenantKey: "slack/T1", surfaceKey: "slack/T1/D1", domains: [] };

  ok(DEFAULT_NETWORK_ACCESS_LEVEL === "none", "the documented floor is \"none\" — byte-identical to pre-OPE-509 behaviour");

  ok(resolveNetworkAccessLevel(chan("slack/T1", "slack/T1/C1"), []) === "none", "no bindings at all -> DEFAULT (\"none\")");

  const orgOnly: NetworkAccessBinding[] = [defineNetworkAccess({ scope: { level: "org" }, level: "trusted" })];
  ok(resolveNetworkAccessLevel(chan("slack/T1", "slack/T1/C1"), orgOnly) === "trusted", "an org-level pin is the org-wide default");
  ok(resolveNetworkAccessLevel(chan("discord/G1", "discord/G1/C9"), orgOnly) === "trusted", "…and applies on every tenant/surface, since org matches everything");

  const orgPlusSurface: NetworkAccessBinding[] = [
    defineNetworkAccess({ scope: { level: "org" }, level: "full" }),
    defineNetworkAccess({ scope: { level: "surface", surface: "slack/T1/C1" }, level: "trusted" }),
  ];
  ok(
    resolveNetworkAccessLevel(chan("slack/T1", "slack/T1/C1"), orgPlusSurface) === "trusted",
    "a surface-level pin WINS OVER the org default, even though the org default is a DIFFERENT (broader) level",
  );
  ok(
    resolveNetworkAccessLevel(chan("slack/T1", "slack/T1/C2"), orgPlusSurface) === "full",
    "…while a DIFFERENT, unpinned surface still inherits the org default",
  );

  const domainPinned: NetworkAccessBinding[] = [defineNetworkAccess({ scope: { level: "domain", domain: "payments" }, level: "trusted" })];
  ok(
    resolveNetworkAccessLevel(chan("slack/T1", "slack/T1/C1", ["payments"]), domainPinned) === "trusted",
    "an UNPINNED surface inherits its domain's pin",
  );
  ok(
    resolveNetworkAccessLevel(chan("slack/T1", "slack/T1/C9", ["other"]), domainPinned) === "none",
    "…but a surface in a DIFFERENT domain gets nothing from it (falls to the floor)",
  );

  const tenantPinned: NetworkAccessBinding[] = [defineNetworkAccess({ scope: { level: "tenant", tenant: "slack/T1" }, level: "trusted" })];
  ok(resolveNetworkAccessLevel(chan("slack/T1", "slack/T1/C1"), tenantPinned) === "trusted", "a tenant pin applies to every surface in that tenant");
  ok(resolveNetworkAccessLevel(chan("slack/T2", "slack/T2/C1"), tenantPinned) === "none", "…and NOT to a different tenant, even same platform");

  const fullLadder: NetworkAccessBinding[] = [
    defineNetworkAccess({ scope: { level: "surface", surface: "slack/T1/C1" }, level: "full" }),
    defineNetworkAccess({ scope: { level: "domain", domain: "payments" }, level: "trusted" }),
    defineNetworkAccess({ scope: { level: "tenant", tenant: "slack/T1" }, level: "none" }),
    defineNetworkAccess({ scope: { level: "org" }, level: "trusted" }),
  ];
  ok(resolveNetworkAccessLevel(chan("slack/T1", "slack/T1/C1", ["payments"]), fullLadder) === "full", "surface beats domain beats tenant beats org");
  ok(resolveNetworkAccessLevel(chan("slack/T1", "slack/T1/C2", ["payments"]), fullLadder) === "trusted", "domain beats tenant beats org (surface doesn't match this one)");
  ok(resolveNetworkAccessLevel(chan("slack/T1", "slack/T1/C9"), fullLadder) === "none", "tenant beats org (neither surface nor domain match)");
  ok(resolveNetworkAccessLevel(chan("discord/G1", "discord/G1/C1"), fullLadder) === "trusted", "org is the last resort (nothing narrower matches at all)");

  ok(resolveNetworkAccessLevel(dm, fullLadder) === "trusted", "a DM resolves the ORG pin (Tag's Environment object is org-wide, never per-account)");
  const dmMatchingSurface = { mode: "dm" as const, tenantKey: "slack/T1", surfaceKey: "slack/T1/C1", domains: ["payments"] };
  ok(
    resolveNetworkAccessLevel(dmMatchingSurface, fullLadder) === "trusted",
    "🔴 negative control: even when a DM's echoed tenantKey/surfaceKey/domains happen to STRING-MATCH a tenant/domain/surface pin, it does NOT apply in DM mode — only the org pin does (\"trusted\", not \"full\"/\"none\" from the narrower pins)",
  );
}

{
  let threw = false;
  try {
    assertNetworkAccessValid([]);
  } catch {
    threw = true;
  }
  ok(!threw, "an empty list is valid (the shipped default)");

  const throws = (bindings: NetworkAccessBinding[], label: string) => {
    let msg: string | undefined;
    try {
      assertNetworkAccessValid(bindings);
    } catch (err) {
      msg = String(err);
    }
    ok(msg !== undefined, label);
    return msg;
  };

  throws([{ scope: { level: "org" }, level: "unlimited" as never }], "an unknown level is refused");
  throws([{ scope: { level: "group", group: "payments-team" }, level: "trusted" }], "a group-scoped binding is refused (container ladder only)");
  throws([{ scope: { level: "principal", principal: "slack/T1/U1" }, level: "trusted" }], "a principal-scoped binding is refused (container ladder only)");
  throws([{ scope: { level: "tenant" }, level: "trusted" } as never], "a tenant-level binding with no tenant address is refused");
  throws([{ scope: { level: "surface" }, level: "trusted" } as never], "a surface-level binding with no surface address is refused");
  throws([{ scope: { level: "domain" }, level: "trusted" } as never], "a domain-level binding with no domain address is refused");
  throws([{ scope: { level: "org", domain: "payments" } as never, level: "trusted" }], "an org-level binding carrying a stray domain address is refused");
  throws([{ scope: { level: "tenant", tenant: "T1" }, level: "trusted" }], "a bare (unqualified) tenant id is refused — must be platform/<tenant-id>");
  throws([{ scope: { level: "surface", surface: "slack/T1" }, level: "trusted" }], "a two-segment surface key is refused — must be platform/<tenant-id>/<container-id>");
  throws([{ scope: { level: "domain", domain: "pay/ments" }, level: "trusted" }], "a domain address containing \"/\" is refused (domains are bare, cross-platform names)");
  throws(
    [
      { scope: { level: "surface", surface: "slack/T1/C1" }, level: "trusted" },
      { scope: { level: "surface", surface: "slack/T1/C1" }, level: "full" },
    ],
    "two bindings pinning the SAME scope are refused (undefined resolution order)",
  );

  let ok2 = true;
  try {
    assertNetworkAccessValid([
      defineNetworkAccess({ scope: { level: "org" }, level: "none" }),
      defineNetworkAccess({ scope: { level: "tenant", tenant: "slack/T1" }, level: "trusted" }),
      defineNetworkAccess({ scope: { level: "domain", domain: "payments" }, level: "full" }),
      defineNetworkAccess({ scope: { level: "surface", surface: "slack/T1/C1" }, level: "none" }),
    ]);
  } catch {
    ok2 = false;
  }
  ok(ok2, "a well-formed config spanning all four container-ladder levels loads clean");
}

{
  const captured = (bindings: NetworkAccessBinding[]): string[] => {
    const messages: string[] = [];
    assertNetworkAccessValid(bindings, { warn: (m) => messages.push(m) });
    return messages;
  };

  const orgFull = captured([defineNetworkAccess({ scope: { level: "org" }, level: "full" })]);
  ok(orgFull.length === 1, "a \"full\" pin at org scope fires exactly one warning");
  ok(orgFull[0]!.includes("broad grant") && orgFull[0]!.includes("org"), "the warning names it a broad grant and names the org scope");

  const tenantFull = captured([defineNetworkAccess({ scope: { level: "tenant", tenant: "slack/T1" }, level: "full" })]);
  ok(tenantFull.length === 1, "a \"full\" pin at tenant scope fires exactly one warning");
  ok(tenantFull[0]!.includes("broad grant") && tenantFull[0]!.includes("slack/T1"), "the warning names the tenant scope");

  let threw2 = false;
  try {
    assertNetworkAccessValid([defineNetworkAccess({ scope: { level: "org" }, level: "full" })]);
  } catch {
    threw2 = true;
  }
  ok(!threw2, "a \"full\" pin at org scope NEVER refuses boot — warn only (OPE-524)");

  ok(captured([defineNetworkAccess({ scope: { level: "domain", domain: "payments" }, level: "full" })]).length === 0, "…a \"full\" pin at DOMAIN scope stays silent — narrow scope is the whole point");
  ok(captured([defineNetworkAccess({ scope: { level: "surface", surface: "slack/T1/C1" }, level: "full" })]).length === 0, "…a \"full\" pin at SURFACE scope stays silent");
  ok(captured([defineNetworkAccess({ scope: { level: "org" }, level: "trusted" })]).length === 0, "…a \"trusted\" pin at org scope stays silent (curated, reviewed host list — lower blast radius)");
  ok(captured([defineNetworkAccess({ scope: { level: "tenant", tenant: "slack/T1" }, level: "trusted" })]).length === 0, "…a \"trusted\" pin at tenant scope stays silent");
  ok(captured([defineNetworkAccess({ scope: { level: "org" }, level: "none" })]).length === 0, "…a \"none\" pin at org scope stays silent");

  let threw3 = false;
  try {
    assertNetworkAccessValid([defineNetworkAccess({ scope: { level: "org" }, level: "full" })]);
  } catch {
    threw3 = true;
  }
  ok(!threw3, "omitting deps entirely (the real boot call shape) still doesn't throw — falls back to console.warn");
}

{
  const conn = (id: string): Connection => ({ id, credentialType: "bearer", secretRef: "X", allowedWebsites: ["api.acme.test"] }) as unknown as Connection;
  const access = (hosts: ReachableHost[], connections: Connection[] = []): EffectiveAccess =>
    ({
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
      instructionStack: [],
      warnings: [],
    }) as unknown as EffectiveAccess;
  const noOverride = async (ids: readonly string[]) => ids;
  const headers = async () => ({ authorization: "Bearer SECRET" });
  const allowRecord = (p: Awaited<ReturnType<typeof compileNetworkPolicy>>): Record<string, unknown[]> =>
    typeof p === "object" ? ((p as { allow: Record<string, unknown[]> }).allow ?? {}) : {};
  const allowKeys = (p: Awaited<ReturnType<typeof compileNetworkPolicy>>): string[] => Object.keys(allowRecord(p));

  ok(TRUSTED_ACCESS_HOSTS.length === PACKAGE_REGISTRY_HOSTS.length + TRUSTED_ACCESS_DEVELOPER_HOSTS.length, "TRUSTED_ACCESS_HOSTS is exactly package registries UNION developer hosts");
  ok(TRUSTED_ACCESS_HOSTS.includes("registry.npmjs.org"), "…includes the package registries");
  ok(TRUSTED_ACCESS_HOSTS.includes("github.com"), "…includes the one evidenced developer host, github.com");

  const bare = access([]);
  const omitted = await compileNetworkPolicy(bare, headers, noOverride);
  const explicitNone = await compileNetworkPolicy(bare, headers, noOverride, "none");
  ok(omitted === "deny-all" && explicitNone === "deny-all", "\"none\" (omitted or explicit) still compiles to deny-all when nothing else is reachable");

  const trusted = await compileNetworkPolicy(bare, headers, noOverride, "trusted");
  const trustedKeys = allowKeys(trusted);
  ok(trustedKeys.includes("registry.npmjs.org") && trustedKeys.includes("github.com"), "\"trusted\" opens the curated package-registry + developer-host set, from an OTHERWISE-EMPTY bundle grant");
  ok(!trustedKeys.includes("*"), "🔴 negative control: \"trusted\" never adds the unrestricted catch-all — that is \"full\"'s job alone");
  const trustedRule = allowRecord(trusted)["registry.npmjs.org"];
  ok(Array.isArray(trustedRule) && trustedRule.length === 0, "a trusted host compiles to a BARE allow (no transform — never carries a credential)");

  const full = await compileNetworkPolicy(bare, headers, noOverride, "full");
  ok(allowKeys(full).includes("*"), "\"full\" adds the unrestricted \"*\" catch-all");
  ok(!allowKeys(full).includes("registry.npmjs.org"), "🔴 negative control: \"full\" does NOT also enumerate the trusted set by name — it subsumes it via \"*\", it doesn't merge with \"trusted\"");

  const credentialed = access([{ host: "github.com", viaConnection: "acme", methods: ["GET"] }], [conn("acme")]);
  const trustedOverBundle = await compileNetworkPolicy(credentialed, headers, noOverride, "trusted");
  const ghRule = allowRecord(trustedOverBundle)["github.com"];
  ok(
    Array.isArray(ghRule) && ghRule.length === 1 && (ghRule[0] as { match?: { method?: string[] } }).match?.method?.[0] === "GET",
    "a host the bundle ALREADY grants (with its own narrowing) keeps ITS rule — \"trusted\" adds github.com to the allow-list only where the bundle hadn't already opened it",
  );

  const withRepos: EffectiveAccess = { ...access([]), repos: ["acme/web"] } as EffectiveAccess;
  const reposPlusTrusted = await compileNetworkPolicy(withRepos, headers, noOverride, "trusted");
  ok(allowKeys(reposPlusTrusted).includes("github.com"), "repos + \"trusted\" both want github.com — compiles once, no collision");
}

console.log(`\n✓ network-access: ${n} assertions passed (resolveNetworkAccessLevel narrowest-wins/org-default + assertNetworkAccessValid config-load checks + broad-grant warn-only OPE-524 + compileNetworkPolicy per-level compiled-output differences)\n`);

// proves: AP-MOD-core-access-network-access
