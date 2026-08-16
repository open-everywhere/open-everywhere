import assert from "node:assert/strict";

import {
  censusResult,
  classifyEndpoint,
  planRequiredCredentials,
  planRequiredEndpoints,
  proveKeyOpensRow,
  renderCensusReport,
  type MountedRoute,
} from "../packages/core/agent/ops/census.js";
import type { Bundle } from "../packages/core/agent/access/bundle.js";
import type { ConnectorCredentials } from "../packages/core/agent/access/connector-credentials.js";
import type { WebhookHook } from "../packages/core/agent/webhooks/config.js";

let checks = 0;
const failures: string[] = [];
function check(label: string, fn: () => void): void {
  checks++;
  try {
    fn();
  } catch (err) {
    failures.push(`${label}\n      ${String(err instanceof Error ? err.message : err)}`);
  }
}

const CATALOGUES: readonly ConnectorCredentials[] = [
  {
    description: "test connector",
    connector: "acme",
    allows: ["api-key", "user-oauth"],
    credentials: [
      { id: "team-key", type: "api-key", secretRef: "db:acme:team-key", broker: "db" },
      { id: "channel-key", type: "api-key", secretRef: "db:acme:channel-key", broker: "db" },
      { id: "payments-key", type: "api-key", secretRef: "db:acme:payments-key", broker: "db" },
      { id: "channel-key-unused", type: "api-key", secretRef: "db:acme:channel-key-unused", broker: "db" },
      { id: "env-key", type: "api-key", secretRef: "ACME_ENV_KEY", broker: "env" },
      { id: "user-oauth", type: "user-oauth", home: { name: "vercel-connect", config: { vercelConnector: "acme" } } },
    ],
  } as unknown as ConnectorCredentials,
];

const BUNDLES: readonly Bundle[] = [
  {
    name: "acme-basket",
    connections: [{ id: "acme-rest", credentialType: "bearer", secretRef: "db:acme:team-key", broker: "db", allowedWebsites: ["api.acme.test"] }],
    connectors: [{ name: "acme", credential: "team-key", contentOrigin: "external" }],
  },
  {
    name: "acme-env-basket",
    connections: [{ id: "acme-env", credentialType: "bearer", secretRef: "ACME_ENV_KEY", broker: "env", allowedWebsites: ["api.acme.test"] }],
    connectors: [{ name: "acme", credential: "env-key", contentOrigin: "external" }],
  },
  { name: "acme-personal", connectors: [{ name: "acme", credential: "user-oauth", contentOrigin: "external" }] },
] as unknown as readonly Bundle[];

const DOMAINS = [
  { name: "payments", credentials: [{ connector: "acme", credential: "channel-key", use: "payments-key" }] },
  { name: "legal" },
];

function hook(over: Partial<WebhookHook> & { id: string }): WebhookHook {
  return {
    source: "oe-standard-webhook",
    secretRef: "ACME_HOOK_SECRET",
    broker: "env",
    target: "slack/T1/C1",
    readableBy: [{ level: "org" }],
    instruction: "test",
    ...over,
  } as unknown as WebhookHook;
}

const HOOKS: readonly WebhookHook[] = [
  hook({ id: "env-hook" }),
  hook({ id: "db-hook", broker: "db", secretRef: ["db:webhook:db-hook-v2", "db:webhook:db-hook"] }),
];

const PLUMBING = [{ connector: "acme", credentialId: "channel-key", reason: "the mounted acme channel resolves it" }];

const PLAN = planRequiredCredentials({
  bundles: BUNDLES,
  catalogues: CATALOGUES,
  domains: DOMAINS,
  hooks: HOOKS,
  plumbing: PLUMBING,
});
const REFS = PLAN.required.map((r) => r.ref);

check("a bundle's db-brokered EGRESS connection makes its ref required, named by bundle and connection", () => {
  const found = PLAN.required.find((r) => r.ref === "db:acme:team-key");
  assert.ok(found, "db:acme:team-key is required");
  assert.match(found.reason, /bundle "acme-basket" egress connection "acme-rest"/u);
});

check("a bundle's CONNECTOR GRANT makes its catalogue credential required, and the two reasons merge on one ref", () => {
  const found = PLAN.required.find((r) => r.ref === "db:acme:team-key");
  assert.match(found?.reason ?? "", /grants connector "acme" as "team-key"/u);
  assert.equal(REFS.filter((r) => r === "db:acme:team-key").length, 1, "the ref appears exactly once");
});

check("a DOMAIN binding requires the credential it names in `use`, not the role it replaces", () => {
  assert.ok(REFS.includes("db:acme:payments-key"), "the bound credential is required");
  const found = PLAN.required.find((r) => r.ref === "db:acme:payments-key");
  assert.match(found?.reason ?? "", /domain "payments"/u);
});

check("PROVIDER PLUMBING requires a credential no grant and no binding names — the incident's own shape", () => {
  const found = PLAN.required.find((r) => r.ref === "db:acme:channel-key");
  assert.ok(found, "db:acme:channel-key is required");
  assert.match(found.reason, /the mounted acme channel resolves it/u);
});

check("a db-brokered HOOK requires EVERY ref in its rotation list, current key and overlap alike", () => {
  assert.ok(REFS.includes("db:webhook:db-hook-v2"), "the current key is required");
  assert.ok(REFS.includes("db:webhook:db-hook"), "the rotation overlap is required too");
});

check("NEGATIVE CONTROL — an env-brokered credential, an OAuth credential and an env-brokered hook require NOTHING", () => {
  assert.equal(REFS.includes("ACME_ENV_KEY"), false, "an env var name is not a store row");
  assert.equal(REFS.includes("ACME_HOOK_SECRET"), false, "an env-brokered hook contributes no row");
  assert.equal(
    REFS.some((r) => r.includes("user-oauth")),
    false,
    "an OAuth credential holds no broker ref at all",
  );
  assert.deepEqual(
    [...REFS].sort(),
    ["db:acme:channel-key", "db:acme:payments-key", "db:acme:team-key", "db:webhook:db-hook", "db:webhook:db-hook-v2"],
    "the required set is exactly the five db-homed refs",
  );
});

check("a grant naming a credential the connector does not configure is a PROBLEM, never a silent drop", () => {
  const plan = planRequiredCredentials({
    bundles: [{ name: "ghost", connectors: [{ name: "acme", credential: "no-such-key" }] }] as unknown as readonly Bundle[],
    catalogues: CATALOGUES,
    domains: [],
    hooks: [],
    plumbing: [],
  });
  assert.equal(plan.required.length, 0, "nothing is required");
  assert.equal(plan.problems.length, 1, "…but the config problem is reported");
  assert.match(plan.problems[0] ?? "", /bundle "ghost" names credential "no-such-key"/u);
});

check("a DECLARED-but-unreached db credential is inventoried, never required — the `db:notion:memory` shape", () => {
  const refs = PLAN.declaredOnly.map((d) => d.ref);
  assert.deepEqual(refs, ["db:acme:channel-key-unused"], "only the credential no live path names is inventoried");
  assert.equal(
    PLAN.required.some((r) => r.ref === "db:acme:channel-key-unused"),
    false,
    "…and it never gates the census",
  );
  assert.match(PLAN.declaredOnly[0]?.reason ?? "", /no grant, binding or plumbing names it/u);
});

check("the key check PASSES when the envelope opens, and returns no plaintext", () => {
  const proof = proveKeyOpensRow({ ref: "db:acme:team-key", ciphertext: "envelope", decrypt: () => "s3cret-value" });
  assert.equal(proof.ok, true);
  assert.equal(proof.detail.includes("s3cret"), false, "the detail never carries the value");
  assert.equal(JSON.stringify(proof).includes("s3cret"), false, "…nor does any other field");
});

check("the key check goes RED when the key does not open the row, and names the consequence", () => {
  const proof = proveKeyOpensRow({
    ref: "db:acme:team-key",
    ciphertext: "envelope",
    decrypt: () => {
      throw new Error("auth tag mismatch");
    },
  });
  assert.equal(proof.ok, false);
  assert.match(proof.detail, /every broker:"db" credential fails closed at once/u);
});

check("an envelope that opens to an EMPTY value is RED — a row that exists and carries nothing", () => {
  const proof = proveKeyOpensRow({ ref: "db:acme:team-key", ciphertext: "envelope", decrypt: () => "" });
  assert.equal(proof.ok, false);
  assert.match(proof.detail, /EMPTY/u);
});

const ROUTES: readonly MountedRoute[] = [
  { channel: "acme.ts", method: "POST", path: "/eve/v1/acme" },
  { channel: "acme.ts", method: "GET", path: "/eve/v1/acme/health" },
  { channel: "webhooks.ts", method: "POST", path: "/webhooks/:id" },
  { channel: "intake.ts", method: "GET", path: "/connect/v1/intake" },
  { channel: "intake.ts", method: "POST", path: "/connect/v1/intake" },
  { channel: "params.ts", method: "POST", path: "/eve/v1/thing/:thingId" },
];
const ENDPOINTS = planRequiredEndpoints({ routes: ROUTES, hooks: HOOKS, controlHookId: "no-such-hook" });
const PATHS = ENDPOINTS.endpoints.map((e) => e.path);

check("`/webhooks/:id` expands to one probe per DECLARED hook, plus the undeclared negative control", () => {
  assert.ok(PATHS.includes("/webhooks/env-hook"), "the env hook is probed — its route is mounted regardless of custody");
  assert.ok(PATHS.includes("/webhooks/db-hook"), "the db hook is probed");
  const control = ENDPOINTS.endpoints.find((e) => e.path === "/webhooks/no-such-hook");
  assert.equal(control?.expect, "absent", "the control must 404");
});

check("a POST route SHARING its path with a GET route is skipped as a token-gated page, with the reason stated", () => {
  assert.equal(PATHS.includes("/connect/v1/intake"), false, "not probed");
  const skipped = ENDPOINTS.skipped.find((s) => s.path === "/connect/v1/intake");
  assert.match(skipped?.reason ?? "", /answers 404 without its signed token/u);
});

check("the negative control MOVES when a real hook already declares that id — it can never collide", () => {
  const plan = planRequiredEndpoints({ routes: ROUTES, hooks: [hook({ id: "taken" })], controlHookId: "taken" });
  const paths = plan.endpoints.map((e) => e.path);
  assert.deepEqual(paths.filter((p) => p.startsWith("/webhooks/")).sort(), ["/webhooks/taken", "/webhooks/taken-x"]);
  assert.equal(plan.endpoints.find((e) => e.path === "/webhooks/taken")?.expect, "mounted", "the declared hook must refuse");
  assert.equal(plan.endpoints.find((e) => e.path === "/webhooks/taken-x")?.expect, "absent", "…and the control moved aside");
});

check("a parameterised POST route that is not the webhook route is skipped, and GET routes are never probed", () => {
  assert.equal(PATHS.includes("/eve/v1/thing/:thingId"), false, "no invented path parameter");
  assert.match(ENDPOINTS.skipped.find((s) => s.path === "/eve/v1/thing/:thingId")?.reason ?? "", /cannot synthesise/u);
  assert.equal(PATHS.includes("/eve/v1/acme/health"), false, "a GET route is not an unsigned-POST ingress");
  assert.ok(PATHS.includes("/eve/v1/acme"), "…but the channel's POST ingress is probed");
});

check("a status classifies into exactly one state, and a 2xx is NOT a pass", () => {
  assert.equal(classifyEndpoint(401), "mounted");
  assert.equal(classifyEndpoint(403), "mounted");
  assert.equal(classifyEndpoint(400), "mounted");
  assert.equal(classifyEndpoint(404), "absent");
  assert.equal(classifyEndpoint(200), "accepted-unsigned");
  assert.equal(classifyEndpoint(302), "accepted-unsigned");
  assert.equal(classifyEndpoint(500), "server-error");
  assert.equal(classifyEndpoint(undefined), "unreachable");
});

const ALL_PRESENT = REFS;
const ALL_REFUSED = ENDPOINTS.endpoints.map((e) => ({ path: e.path, status: e.expect === "absent" ? 404 : 401 }));
const clean = (over: Partial<Parameters<typeof censusResult>[0]> = {}) =>
  censusResult({
    target: "https://oe.example.test",
    storeLabel: "hosted Postgres (DATABASE_URL)",
    plan: PLAN,
    endpoints: ENDPOINTS,
    presentRefs: ALL_PRESENT,
    observations: ALL_REFUSED,
    ...over,
  });

check("a complete census is GREEN, and it actually asserted something (five rows, four probes)", () => {
  const result = clean();
  assert.equal(result.ok, true, "clean census passes");
  assert.equal(result.credentials.length, 5, "five credential rows were checked");
  assert.equal(result.credentials.every((c) => c.present), true);
  assert.equal(result.endpoints.length, 4, "two hook probes, the negative control, and the channel ingress");
  assert.equal(result.endpoints.every((e) => e.ok), true);
});

check("THE INCIDENT — one missing row goes RED, and the report names that exact ref", () => {
  const result = clean({ presentRefs: REFS.filter((r) => r !== "db:acme:channel-key") });
  assert.equal(result.ok, false, "a missing required row fails the census");
  assert.equal(result.credentials.find((c) => c.ref === "db:acme:channel-key")?.present, false);
  assert.equal(result.credentials.filter((c) => !c.present).length, 1, "only the missing one is reported missing");
  const report = renderCensusReport(result).join("\n");
  assert.match(report, /missing credential row\(s\): db:acme:channel-key/u);
  assert.match(report, /✗ deploy:census/u);
});

check("PRESENCE IS EXACT — a near-miss ref name does not satisfy the requirement", () => {
  const result = clean({ presentRefs: REFS.map((r) => (r === "db:acme:team-key" ? "db:acme:team-key2" : r)) });
  assert.equal(result.ok, false, "a prefix/near-miss is not a match");
  assert.equal(result.credentials.find((c) => c.ref === "db:acme:team-key")?.present, false);
});

check("a store holding EXTRA refs nobody requires is still clean — the census asserts presence, not equality", () => {
  const result = clean({ presentRefs: [...REFS, "db:acme:retired-key", "oe-oauth:tok:whatever"] });
  assert.equal(result.ok, true);
});

check("A DECLARED HOOK THAT 404s goes RED and is named as absent", () => {
  const result = clean({ observations: ALL_REFUSED.map((o) => (o.path === "/webhooks/db-hook" ? { path: o.path, status: 404 } : o)) });
  assert.equal(result.ok, false, "the deployment does not carry the declaration");
  const finding = result.endpoints.find((e) => e.path === "/webhooks/db-hook");
  assert.equal(finding?.state, "absent");
  assert.match(renderCensusReport(result).join("\n"), /route\(s\) that did not answer as required: POST \/webhooks\/db-hook/u);
});

check("AN INGRESS THAT ACCEPTS AN UNSIGNED POST goes RED, classified as accepted-unsigned", () => {
  const result = clean({ observations: ALL_REFUSED.map((o) => (o.path === "/eve/v1/acme" ? { path: o.path, status: 200 } : o)) });
  assert.equal(result.ok, false, "a 200 on an unsigned delivery is never a pass");
  assert.equal(result.endpoints.find((e) => e.path === "/eve/v1/acme")?.state, "accepted-unsigned");
});

check("ANTI-VACUITY — if the UNDECLARED control id also answers 401, the census goes RED", () => {
  const result = clean({ observations: ALL_REFUSED.map((o) => (o.path === "/webhooks/no-such-hook" ? { path: o.path, status: 401 } : o)) });
  assert.equal(result.ok, false, "every id answering means the hook probes prove nothing");
  assert.equal(result.endpoints.find((e) => e.path === "/webhooks/no-such-hook")?.ok, false);
});

check("an UNREACHABLE deployment goes RED rather than passing on a silent network failure", () => {
  const result = clean({ observations: ENDPOINTS.endpoints.map((e) => ({ path: e.path })) });
  assert.equal(result.ok, false);
  assert.equal(result.endpoints.every((e) => e.state === "unreachable"), true);
});

check("a CONFIG PROBLEM alone fails the census, even with every row present and every route answering", () => {
  const result = clean({ plan: { required: PLAN.required, declaredOnly: [], problems: ["bundle \"ghost\" names credential \"no-such-key\"…"] } });
  assert.equal(result.ok, false, "an unresolvable grant is a census failure");
  assert.match(renderCensusReport(result).join("\n"), /CONFIG PROBLEMS \(1\)/u);
});

check("A FAILED KEY CHECK alone fails the census — every row present and unreadable is the worst green", () => {
  const green = clean({ keyProof: { ref: "db:acme:team-key", ok: true, detail: "opens" } });
  assert.equal(green.ok, true, "a passing key check does not change a clean census");
  const result = clean({ keyProof: { ref: "db:acme:team-key", ok: false, detail: "the AES key did NOT open this row" } });
  assert.equal(result.ok, false, "unreadable rows fail the census even though every ref is present");
  assert.equal(result.credentials.every((c) => c.present), true, "…and presence alone would have passed");
  assert.match(renderCensusReport(result).join("\n"), /encryption key: the AES key did NOT open this row/u);
});

check("a DECLARED-not-required row is reported with its presence and never changes the verdict", () => {
  const absent = clean();
  assert.equal(absent.declared.length, 1);
  assert.equal(absent.declared[0]?.present, false, "the store does not hold it");
  assert.equal(absent.ok, true, "…and the census is still clean");
  assert.match(renderCensusReport(absent).join("\n"), /DECLARED, NOT REQUIRED \(1\)/u);
});

check("the report states what it did NOT prove, so a green is never read as wider than it is", () => {
  const report = renderCensusReport(clean({ limits: ["the relay that feeds /eve/v1/discord-gateway is not observable from here"] })).join("\n");
  assert.match(report, /NOT PROVEN BY THIS CENSUS \(1\)/u);
  assert.match(report, /relay that feeds/u);
});

if (failures.length > 0) {
  console.error(`✗ deploy-census: ${failures.length} of ${checks} check(s) FAILED`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`✓ deploy-census: ${checks} check(s) passed (required-set derivation, endpoint plan, the four reds, the anti-vacuity control — all offline)`);
