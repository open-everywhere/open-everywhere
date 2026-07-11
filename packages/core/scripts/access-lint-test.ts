import assert from "node:assert/strict";
import { defineBundle, defineBinding, type Bundle, type Binding, type Connection } from "../agent/access/bundle.js";
import { lintBroadGrants, lintMethodNarrowing, lintAccessConfig } from "../agent/access/lint.js";

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

const at = (bundle: string, level: "org" | "workspace" | "domain" | "channel", over: Partial<Binding> = {}): Binding =>
  defineBinding({
    bundle,
    scope: { level, ...(level === "org" ? {} : { workspace: "T1" }), ...(level === "domain" ? { domain: "eng" } : {}), ...(level === "channel" ? { channel: "C1" } : {}) },
    ...over,
  });

ok(lintBroadGrants([credentialed], [at("creds", "org")]).some((p) => p.includes("broad credentialed grant")), "a credentialed bundle bound at ORG scope FAILS");
ok(lintBroadGrants([credentialed], [at("creds", "workspace")]).some((p) => p.includes("workspace scope")), "a credentialed bundle bound at WORKSPACE scope FAILS");
ok(lintBroadGrants([credentialed], [at("creds", "domain")]).length === 0, "the same bundle at DOMAIN scope is clean (the intended path)");
ok(lintBroadGrants([credentialed], [at("creds", "channel")]).length === 0, "…and at CHANNEL scope");
ok(lintBroadGrants([credentialless], [at("safe", "org")]).length === 0, "a credential-LESS bundle at org scope stays warn-only (not a CI failure)");
ok(
  lintBroadGrants([credentialed], [defineBinding({ bundle: "creds", scope: { level: "workspace", workspace: "dm:U123" } })]).length === 0,
  "a dm: workspace is one person's own scope — not broad",
);

for (const [field, bundle] of [
  ["providers", defineBundle({ name: "b", providers: [{ provider: "notion", credential: "k" }] })],
  ["repos", defineBundle({ name: "b", repos: ["acme/web"] })],
  ["connectors", defineBundle({ name: "b", connectors: ["notion"] })],
] as const) {
  ok(lintBroadGrants([bundle], [at("b", "workspace")]).length === 1, `broad ${field} grants FAIL like connections do`);
}

ok(
  lintBroadGrants([credentialed], [at("creds", "workspace", { allowBroad: "single-operator test workspace" })]).length === 0,
  "allowBroad with a real reason accepts the broad grant deliberately",
);
ok(
  lintBroadGrants([credentialed], [at("creds", "workspace", { allowBroad: "  " })]).some((p) => p.includes("EMPTY allowBroad")),
  "an empty/whitespace allowBroad FAILS — the escape must name the reason",
);
ok(
  lintBroadGrants([credentialed], [at("creds", "channel", { allowBroad: "why is this here" })]).some((p) => p.includes("isn't a broad scope")),
  "allowBroad on a narrow binding FAILS (a stray escape suggests a misunderstanding)",
);
ok(lintBroadGrants([credentialed], [defineBinding({ bundle: "ghost", scope: { level: "org" } })]).length === 0, "an unknown bundle ref is assertBindingsValid's problem, not this lint's");

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
  const problems = lintAccessConfig(
    [defineBundle({ name: "bad", connections: [conn({ methods: undefined })] })],
    [at("bad", "org")],
  );
  ok(problems.length === 2, `both lints report through lintAccessConfig (got ${problems.length}: ${JSON.stringify(problems)})`);
}

console.log(`✓ ${n} access-lint assertions passed`);
