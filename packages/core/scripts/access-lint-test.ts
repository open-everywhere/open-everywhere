import assert from "node:assert/strict";
import { defineBundle, defineBinding, type Bundle, type Binding, type Connection } from "../agent/access/bundle.js";
import { lintBroadGrants, lintMethodNarrowing, lintAccessConfig } from "../agent/access/lint.js";
import { defineDomain } from "../agent/memory/domain.js";
import type { Group } from "../agent/identity/groups.js";

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
  ["providers", defineBundle({ name: "b", providers: [{ provider: "notion", credential: "k" }] })],
  ["repos", defineBundle({ name: "b", repos: ["acme/web"] })],
  ["connectors", defineBundle({ name: "b", connectors: ["notion"] })],
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

const rosterDomain = defineDomain({ name: "eng", channels: ["slack/T1/C1", "github/acme/web"] });
const claimDomain = defineDomain({ name: "eng", containers: ["github/acme"] });
const bothDomain = defineDomain({ name: "eng", channels: ["slack/T1/C1"], containers: ["github/acme"] });
const otherClaimDomain = defineDomain({ name: "ops", containers: ["github/other"] });

ok(
  lintBroadGrants([credentialed], [at("creds", "domain")], [rosterDomain]).length === 0,
  "a domain binding onto a ROSTER domain stays clean — an enumerated membership is the intended narrow path",
);
ok(
  lintBroadGrants([credentialed], [at("creds", "domain")], [claimDomain]).some((p) => p.includes("via domain claim")),
  "a domain binding onto a TENANT-CLAIMING domain FAILS — the width is real even though the binding reads as narrow",
);
ok(
  lintBroadGrants([credentialed], [at("creds", "domain")], [claimDomain]).some((p) => p.includes("github/acme") && p.includes("containers")),
  "…and the failure names the claimed tenant AND the field, because the fix may be in the domain file rather than the binding",
);
ok(
  lintBroadGrants([credentialed], [at("creds", "domain")], [bothDomain]).some((p) => p.includes("via domain claim")),
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
  lintBroadGrants([credentialed], [at("creds", "domain", { allowBroad: "stale" })], [rosterDomain]).some((p) => p.includes("claims none")),
  "allowBroad left behind after `containers` was REMOVED fails, and says why — otherwise narrowing your own domain looks like an unrelated regression",
);
ok(
  lintBroadGrants([credentialless], [at("safe", "domain")], [defineDomain({ name: "eng", containers: ["github/acme"] })]).length === 0,
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
  lintAccessConfig([credentialed], [at("creds", "domain")], [claimDomain]).some((p) => p.includes("via domain claim")),
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
  const problems = lintAccessConfig(
    [defineBundle({ name: "bad", connections: [conn({ methods: undefined })] })],
    [at("bad", "org")],
  );
  ok(problems.length === 2, `both lints report through lintAccessConfig (got ${problems.length}: ${JSON.stringify(problems)})`);
}

console.log(`✓ ${n} access-lint assertions passed`);
