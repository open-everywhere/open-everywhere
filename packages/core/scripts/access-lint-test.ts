import assert from "node:assert/strict";
import { defineBundle, defineBinding, type Bundle, type Binding, type Connection } from "../agent/access/bundle.js";
import { lintBroadGrants, lintEgressHostCollisions, lintMethodNarrowing, lintAccessConfig, lintReservedBrokerHosts, ownAccountWithholdingProblems } from "../agent/access/lint.js";
import { defineDomain } from "../agent/memory/domain.js";
import type { Group } from "../agent/identity/groups.js";
import type { ConnectorCredentials } from "../agent/access/connector-credentials.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const conn = (over: Partial<Connection> = {}): Connection => ({
  id: "api",
  credentialType: "bearer",
  secretRef: "API_KEY",
  allowedWebsites: ["api.example.com"],
  methods: ["GET", "HEAD"],
  ...over,
});

const credentialed: Bundle = defineBundle({ name: "creds", connections: [conn()] });
const credentialless: Bundle = defineBundle({ name: "safe", domains: ["raw.githubusercontent.com"], instructions: "be careful" });

const at = (bundle: string, level: "org" | "tenant" | "domain" | "surface", over: Partial<Binding> = {}): Binding =>
  defineBinding({
    bundle,
    scope: {
      level,
      ...(level === "tenant" ? { tenant: "slack/T1" } : {}),
      ...(level === "domain" ? { domain: "eng" } : {}),
      ...(level === "surface" ? { surface: "slack/T1/C1" } : {}),
    },
    ...over,
  });

ok(lintBroadGrants([credentialed], [at("creds", "org")]).some((p) => p.includes("broad credentialed grant")), "a credentialed bundle bound at ORG scope FAILS");
ok(lintBroadGrants([credentialed], [at("creds", "tenant")]).some((p) => p.includes("tenant scope")), "a credentialed bundle bound at TENANT scope FAILS");
ok(lintBroadGrants([credentialed], [at("creds", "domain")]).length === 0, "the same bundle at DOMAIN scope is clean (the intended path)");
ok(lintBroadGrants([credentialed], [at("creds", "surface")]).length === 0, "…and at SURFACE scope");
ok(lintBroadGrants([credentialless], [at("safe", "org")]).length === 0, "a credential-LESS bundle at org scope stays warn-only (not a CI failure)");
ok(
  lintBroadGrants([credentialed], [defineBinding({ bundle: "creds", scope: { level: "principal", principal: "slack/T1/U123" } })]).length === 0,
  "a principal scope is one person's own — not broad (OPE-219: a level now, not a dm: sentinel the lint had to sniff for)",
);

for (const [field, bundle] of [
  ["connectors", defineBundle({ name: "b", connectors: [{ name: "notion", credential: "k", contentOrigin: "external" }] })],
  ["repos", defineBundle({ name: "b", repos: ["acme/web"] })],
  ["awsRoles", defineBundle({ name: "b", awsRoles: [{ roleArn: "arn:aws:iam::123456789012:role/oe", region: "eu-west-2", allow: ["logs:Describe*"] }] })],
] as const) {
  ok(lintBroadGrants([bundle], [at("b", "tenant")]).length === 1, `broad ${field} grants FAIL like connections do`);
}

ok(
  lintBroadGrants([credentialed], [at("creds", "tenant", { allowBroad: "single-operator test workspace" })]).length === 0,
  "allowBroad with a real reason accepts the broad grant deliberately",
);
ok(
  lintBroadGrants([credentialed], [at("creds", "tenant", { allowBroad: "  " })]).some((p) => p.includes("EMPTY allowBroad")),
  "an empty/whitespace allowBroad FAILS — the escape must name the reason",
);
ok(
  lintBroadGrants([credentialed], [at("creds", "surface", { allowBroad: "why is this here" })]).some((p) => p.includes("isn't a broad scope")),
  "allowBroad on a narrow binding FAILS (a stray escape suggests a misunderstanding)",
);
ok(lintBroadGrants([credentialed], [defineBinding({ bundle: "ghost", scope: { level: "org" } })]).length === 0, "an unknown bundle ref is assertBindingsValid's problem, not this lint's");

const rosterDomain = defineDomain({ name: "eng", reach: ["slack/T1/C1", "github/acme/web"] });
const claimDomain = defineDomain({ name: "eng", reach: ["github/acme"] });
const bothDomain = defineDomain({ name: "eng", reach: ["slack/T1/C1", "github/acme"] });
const otherClaimDomain = defineDomain({ name: "ops", reach: ["github/other"] });

ok(
  lintBroadGrants([credentialed], [at("creds", "domain")], [rosterDomain]).length === 0,
  "a domain binding onto a ROSTER domain stays clean — an enumerated membership is the intended narrow path",
);
ok(
  lintBroadGrants([credentialed], [at("creds", "domain")], [claimDomain]).some((p) => p.includes("via domain container")),
  "a domain binding onto a TENANT-CLAIMING domain FAILS — the width is real even though the binding reads as narrow",
);
ok(
  lintBroadGrants([credentialed], [at("creds", "domain")], [claimDomain]).some((p) => p.includes("github/acme") && p.includes("`reach`")),
  "…and the failure names the reached tenant AND the field, because the fix may be in the domain file rather than the binding",
);
ok(
  lintBroadGrants([credentialed], [at("creds", "domain")], [bothDomain]).some((p) => p.includes("via domain container")),
  "a domain with BOTH a roster and a claim is broad — width is decided by the widest part, never excused by the narrow part",
);
ok(
  lintBroadGrants([credentialed], [at("creds", "domain")], [otherClaimDomain]).length === 0,
  "a claim on a DIFFERENT domain does not taint this binding — the lint matches the domain the binding actually names",
);
ok(
  lintBroadGrants([credentialed], [at("creds", "domain", { allowBroad: "one-owner deployment, every repo is ours" })], [claimDomain]).length === 0,
  "allowBroad on the binding accepts a claim-broad domain deliberately — ONE acknowledgement concept, not a second mechanism",
);
ok(
  lintBroadGrants([credentialed], [at("creds", "domain", { allowBroad: "  " })], [claimDomain]).some((p) => p.includes("EMPTY allowBroad")),
  "an empty allowBroad fails on a claim-broad domain exactly as it does at tenant scope",
);
ok(
  lintBroadGrants([credentialed], [at("creds", "domain", { allowBroad: "stale" })], [rosterDomain]).some((p) => p.includes("reaches none")),
  "allowBroad left behind after the container entry was REMOVED fails, and says why — otherwise narrowing your own domain looks like an unrelated regression",
);
{
  const broadCopy = lintBroadGrants([credentialed], [at("creds", "domain")], [claimDomain]).join("\n");
  ok(broadCopy.includes("container `reach` entries"), "the broad-grant remedy names the CURRENT field");
  ok(broadCopy.includes("agent/memory/config/domains/<name>.ts"), "…and the per-domain config directory that holds it");
  ok(!broadCopy.includes("domains/eng.ts"), "…and never GUESSES the filename from the domain name — nothing ties the two, so a guessed path opens nothing");
  ok(!broadCopy.includes("`containers`") && !broadCopy.includes("`channels`"), "…and never a field the config no longer has");
  const narrowCopy = lintBroadGrants([credentialed], [at("creds", "domain", { allowBroad: "stale" })], [rosterDomain]).join("\n");
  ok(!narrowCopy.includes("`containers`"), "the stale-allowBroad remedy is on the same vocabulary");
}
ok(
  lintBroadGrants([credentialless], [at("safe", "domain")], [defineDomain({ name: "eng", reach: ["github/acme"] })]).length === 0,
  "a credential-LESS bundle on a claim-broad domain stays warn-only, exactly as it does at org/tenant scope",
);
ok(
  lintBroadGrants([credentialed], [at("creds", "domain")]).length === 0 &&
    lintBroadGrants([credentialed], [at("creds", "domain")], []).length === 0,
  "with no domain registry passed, a domain binding is never claim-broad — the lint declines to guess",
);
ok(
  lintBroadGrants([credentialed], [at("creds", "domain")], [otherClaimDomain, rosterDomain]).length === 0,
  "an unknown/absent domain name contributes no claim rather than a spurious failure",
);
ok(
  lintAccessConfig([credentialed], [at("creds", "domain")], [claimDomain]).some((p) => p.includes("via domain container")),
  "lintAccessConfig threads the registry through — the CI gate sees claim-broadness, not just the unit test",
);

ok(
  lintMethodNarrowing([defineBundle({ name: "b", connections: [conn({ methods: undefined })] })]).some((p) => p.includes("declares no `methods`")),
  "a connection with NO methods declaration FAILS",
);
ok(lintMethodNarrowing([defineBundle({ name: "b", connections: [conn({ methods: [] })] })]).length === 1, "an EMPTY methods list FAILS the same way");
ok(lintMethodNarrowing([defineBundle({ name: "b", connections: [conn()] })]).length === 0, "read-only GET/HEAD narrowing is clean");
ok(
  lintMethodNarrowing([defineBundle({ name: "b", connections: [conn({ methods: ["GET", "POST", "PATCH", "DELETE"] })] })]).length === 0,
  "a wide-but-EXPLICIT methods list is clean — naming every method IS the reviewed declaration",
);
ok(lintMethodNarrowing([credentialless]).length === 0, "a bundle with no connections has nothing to narrow");

{
  const bind: Binding = defineBinding({ bundle: "creds", scope: { level: "group", group: "team" } });
  const wide: Group = { name: "team", members: ["slack/T1/U1", { linkSet: "set-a" }] };
  const narrow: Group = { name: "team", members: ["slack/T1/U1", "slack/T1/U2"] };
  ok(lintBroadGrants([credentialed], [bind], [], [wide]).length === 1, "a credentialed GROUP binding onto a link-set-bearing group needs allowBroad");
  ok(lintAccessConfig([credentialed], [bind], [], [narrow]).length === 0, "…and a small, fully-enumerated group is clean through lintAccessConfig");
}

{
  const twoInOne = defineBundle({
    name: "two-in-one",
    connections: [conn({ id: "notion-a", allowedWebsites: ["api.notion.com"] }), conn({ id: "notion-b", allowedWebsites: ["API.Notion.com"] })],
  });
  const withinBundle = lintEgressHostCollisions([twoInOne], []);
  ok(withinBundle.length === 1, `two connections claiming one host inside ONE bundle is one problem (got ${withinBundle.length})`);
  ok(withinBundle[0]!.includes("notion-a") && withinBundle[0]!.includes("notion-b"), "…and the message names BOTH connection ids");
  ok(withinBundle[0]!.includes("api.notion.com"), "…and the normalised host, so a case-only difference is still one host");

  const oneConn = defineBundle({
    name: "one-conn",
    connections: [conn({ id: "notion", allowedWebsites: ["api.notion.com", "api.notion.com", "mcp.notion.com"] })],
  });
  ok(lintEgressHostCollisions([oneConn], []).length === 0, "one connection claiming a host twice is ONE credential — clean");

  const wildcard = defineBundle({
    name: "wildcard",
    connections: [
      conn({ id: "notion-wild", allowedWebsites: ["*.notion.com"] }),
      conn({ id: "notion-exact", allowedWebsites: ["api.notion.com"] }),
    ],
  });
  const wild = lintEgressHostCollisions([wildcard], []);
  ok(wild.length === 1, `a wildcard and an exact host under it are ONE destination — one problem (got ${wild.length})`);
  ok(wild[0]!.includes("notion-wild") && wild[0]!.includes("notion-exact"), "…naming both connection ids");
  ok(wild[0]!.includes("overlaps"), "…and saying the two spellings overlap rather than pretending they are equal");

  const disjointWild = defineBundle({
    name: "disjoint-wild",
    connections: [
      conn({ id: "a", allowedWebsites: ["*.notion.com"] }),
      conn({ id: "b", allowedWebsites: ["api.linear.app"] }),
    ],
  });
  ok(lintEgressHostCollisions([disjointWild], []).length === 0, "a wildcard and a host under a DIFFERENT suffix do not overlap — clean");
  const apex = defineBundle({
    name: "apex",
    connections: [
      conn({ id: "a", allowedWebsites: ["*.notion.com"] }),
      conn({ id: "b", allowedWebsites: ["notion.com"] }),
    ],
  });
  ok(lintEgressHostCollisions([apex], []).length === 0, "a leftmost-label wildcard does not cover the apex, which it cannot reach either — clean");
}

{
  const a = defineBundle({ name: "team-a", connections: [conn({ id: "notion-a", allowedWebsites: ["api.notion.com"] })] });
  const b = defineBundle({ name: "team-b", connections: [conn({ id: "notion-b", allowedWebsites: ["api.notion.com"] })] });

  const nested = lintEgressHostCollisions([a, b], [at("team-a", "org"), at("team-b", "surface")]);
  ok(nested.length === 1, `an org binding and a surface binding CAN co-resolve — one problem (got ${nested.length})`);
  ok(nested[0]!.includes("notion-a") && nested[0]!.includes("notion-b"), "…naming both connection ids");

  const twoRooms = lintEgressHostCollisions([a, b], [
    defineBinding({ bundle: "team-a", scope: { level: "surface", surface: "slack/T1/C1" } }),
    defineBinding({ bundle: "team-b", scope: { level: "surface", surface: "slack/T1/C2" } }),
  ]);
  ok(twoRooms.length === 0, "two connections for one host bound to two DIFFERENT rooms is the supported case — clean");

  const otherTenant = lintEgressHostCollisions([a, b], [
    defineBinding({ bundle: "team-a", scope: { level: "tenant", tenant: "slack/T9" } }),
    defineBinding({ bundle: "team-b", scope: { level: "surface", surface: "slack/T1/C1" } }),
  ]);
  ok(otherTenant.length === 0, "a tenant binding and a surface in ANOTHER tenant never co-resolve — clean");
  const sameTenant = lintEgressHostCollisions([a, b], [
    defineBinding({ bundle: "team-a", scope: { level: "tenant", tenant: "slack/T1" } }),
    defineBinding({ bundle: "team-b", scope: { level: "surface", surface: "slack/T1/C1" } }),
  ]);
  ok(sameTenant.length === 1, "…and a surface IN that tenant does — one problem");

  const crossUniverse = lintEgressHostCollisions([a, b], [
    defineBinding({ bundle: "team-a", scope: { level: "org" } }),
    defineBinding({ bundle: "team-b", scope: { level: "principal", principal: "slack/T1/U1" } }),
  ]);
  ok(crossUniverse.length === 0, "a room binding and a DM binding are two universes — clean");

  const oneDm = lintEgressHostCollisions([a, b], [
    defineBinding({ bundle: "team-a", scope: { level: "principal", principal: "slack/T1/U1" } }),
    defineBinding({ bundle: "team-b", scope: { level: "principal", principal: "slack/T1/U1" } }),
  ]);
  ok(oneDm.length === 1, "two bundles bound to ONE person's DM collide — the rule covers DMs too");
  const twoPeople = lintEgressHostCollisions([a, b], [
    defineBinding({ bundle: "team-a", scope: { level: "principal", principal: "slack/T1/U1" } }),
    defineBinding({ bundle: "team-b", scope: { level: "principal", principal: "slack/T1/U2" } }),
  ]);
  ok(twoPeople.length === 0, "…and two DIFFERENT people's DMs are two sessions — clean");

  const shared = defineBundle({ name: "team-c", connections: [conn({ id: "notion-a", allowedWebsites: ["api.notion.com"] })] });
  ok(
    lintEgressHostCollisions([a, shared], [at("team-a", "org"), at("team-c", "surface")]).length === 0,
    "two bundles naming the SAME connection id resolve to one credential — clean",
  );

  const many = lintEgressHostCollisions([a, b], [at("team-a", "org"), at("team-b", "surface"), at("team-b", "tenant")]);
  ok(many.length === 1, `one real clash is reported once, not once per binding pair (got ${many.length})`);
}

{
  const withHosts: ConnectorCredentials[] = [
    { connector: "notion", allows: ["api-key"], credentials: [{ id: "team", type: "api-key", secretRef: "N", broker: "env", endpoints: { hosts: ["api.notion.com"] } }] },
  ];
  ok(ownAccountWithholdingProblems(["notion"], withHosts).length === 0, "a credential-grant connector that declares its endpoint hosts is clean");

  const noEndpoints: ConnectorCredentials[] = [
    { connector: "notion", allows: ["api-key"], credentials: [{ id: "team", type: "api-key", secretRef: "N", broker: "env" }] },
  ];
  const bare = ownAccountWithholdingProblems(["notion"], noEndpoints);
  ok(bare.length === 1, `a credential-grant connector whose catalogue declares no endpoint hosts is one problem (got ${bare.length})`);
  ok(bare[0]!.includes("notion") && bare[0]!.includes("OPE-1549"), "…naming the connector and why it matters");

  const missing = ownAccountWithholdingProblems(["linear"], withHosts);
  ok(missing.length === 1 && missing[0]!.includes("NO credential catalogue"), "a credential-grant connector with no catalogue at all is reported, and says so");

  ok(
    ownAccountWithholdingProblems([], noEndpoints).length === 0,
    "a connector that admits NO credential grant is not checked — `endpoints` stays an operator narrowing everywhere else",
  );

  const reachesOutside = defineBundle({
    name: "notion-wide",
    connections: [conn({ id: "notion-files", secretRef: "N", allowedWebsites: ["files.notion.so"] })],
  });
  const gap = ownAccountWithholdingProblems(["notion"], withHosts, [reachesOutside]);
  ok(gap.length === 1, `a connection stamping the vendor's secret while reaching NO catalogue host is one problem (got ${gap.length}: ${JSON.stringify(gap)})`);
  ok(gap[0]!.includes("files.notion.so") && gap[0]!.includes("notion-files"), "…naming the connection and what it actually reaches");
  ok(gap[0]!.includes("api.notion.com"), "…and what the catalogue declares, so an operator sees both sides of the join they must close");

  const seen = defineBundle({
    name: "notion-narrow",
    connections: [conn({ id: "notion", secretRef: "N", allowedWebsites: ["api.notion.com", "files.notion.so"] })],
  });
  ok(ownAccountWithholdingProblems(["notion"], withHosts, [seen]).length === 0, "🔴 a connection reaching one catalogue host is clean — identification covers its WHOLE reach");

  const wildConnection = defineBundle({ name: "w", connections: [conn({ id: "n", secretRef: "N", allowedWebsites: ["*.notion.com"] })] });
  ok(ownAccountWithholdingProblems(["notion"], withHosts, [wildConnection]).length === 0, "a connection WILDCARD covering the catalogue's exact host is identified — overlap, not equality");

  const otherVendor = defineBundle({ name: "other", connections: [conn({ id: "stripe", secretRef: "STRIPE_KEY", allowedWebsites: ["api.stripe.com"] })] });
  ok(ownAccountWithholdingProblems(["notion"], withHosts, [otherVendor]).length === 0, "🔴 a connection stamping a DIFFERENT secret is not notion's key — the join reads the secretRef, never the host string or the bundle");

  const viaHeader = defineBundle({
    name: "hdr",
    connections: [conn({ id: "notion-hdr", secretRef: "UNRELATED", customHeaders: [{ name: "X-Notion", secretRef: "N" }], allowedWebsites: ["files.notion.so"] })],
  });
  ok(ownAccountWithholdingProblems(["notion"], withHosts, [viaHeader]).length === 1, "a connection stamping the vendor's secret through a customHeader is the same key, and reds the same way");

  ok(ownAccountWithholdingProblems(["notion"], withHosts).length === 0, "…and a caller passing NO bundles gets exactly the old one-sided verdict, never a silently weakened one");
}

{
  const claimsBroker = defineBundle({
    name: "gh-key",
    connections: [conn({ id: "github-pat", allowedWebsites: ["github.com"] })],
  });
  const reserved = lintReservedBrokerHosts([claimsBroker]);
  ok(reserved.length === 1, `a connection claiming a broker host is one problem (got ${reserved.length}: ${JSON.stringify(reserved)})`);
  ok(reserved[0]!.includes("github-pat") && reserved[0]!.includes("github.com"), "…naming the connection id and the reserved host");
  ok(reserved[0]!.includes("checkout_repo"), "…and the mechanism that displaces the key, so the message is actionable rather than a verdict");

  const wildBroker = defineBundle({ name: "gh-wild", connections: [conn({ id: "gh", allowedWebsites: ["*.github.com"] })] });
  const wild = lintReservedBrokerHosts([wildBroker]);
  ok(wild.length === 1 && wild[0]!.includes("codeload.github.com"), "a wildcard covering a broker host is reserved too, and the message names the host it overlaps");

  ok(lintReservedBrokerHosts([defineBundle({ name: "ok", connections: [conn({ id: "n", allowedWebsites: ["api.notion.com"] })] })]).length === 0, "a connection on an unrelated host is clean");
  ok(
    lintReservedBrokerHosts([defineBundle({ name: "gh-api", connections: [conn({ id: "gh", allowedWebsites: ["api.github.com"] })] })]).length === 0,
    "🔴 `api.github.com` is NOT reserved — the broker replaces github.com and codeload.github.com and nothing else, so reserving the vendor's whole namespace would break a real connection for no reason",
  );
  ok(lintReservedBrokerHosts([]).length === 0, "no bundles is clean (the scan is not vacuously reporting)");

  ok(
    lintAccessConfig([claimsBroker], [at("gh-key", "org")]).some((p) => p.includes("RESERVED by the git read-broker")),
    "lint 7 reaches the CI gate through lintAccessConfig — a lint nothing runs is not a lint",
  );
}

{
  const problems = lintAccessConfig(
    [defineBundle({ name: "bad", connections: [conn({ methods: undefined })] })],
    [at("bad", "org")],
  );
  ok(problems.length === 2, `both lints report through lintAccessConfig (got ${problems.length}: ${JSON.stringify(problems)})`);
}

{
  const clash = defineBundle({
    name: "clash",
    connections: [conn({ id: "notion-a", allowedWebsites: ["api.notion.com"] }), conn({ id: "notion-b", allowedWebsites: ["api.notion.com"] })],
  });
  const problems = lintAccessConfig([clash], [at("clash", "surface")]);
  ok(
    problems.some((p) => p.includes("notion-a") && p.includes("notion-b") && p.includes("api.notion.com")),
    "lintAccessConfig reports the host collision — the lint is wired into the CI gate",
  );
}

console.log(`✓ ${n} access-lint assertions passed`);
