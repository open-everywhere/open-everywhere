import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  censusResult,
  channelCensusContributions,
  channelGatedHeartbeats,
  classifyEndpoint,
  credentialBrokerArmedFinding,
  cronCeilingHours,
  heartbeatFindings,
  planRequiredCredentials,
  planRequiredEndpoints,
  proveKeyOpensRow,
  relayHeartbeatCeilingHours,
  renderCensusReport,
  runtimeSignalFinding,
  ROUTE_ARMING,
  type ChannelArming,
  type MountedRoute,
} from "../packages/core/agent/ops/census.js";
import { OAUTH_SIGNING_SECRET_ENV } from "../packages/core/agent/control/oauth-tokens.js";
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

const DARK_ROUTES: readonly MountedRoute[] = [
  { channel: "control-mcp.ts", method: "POST", path: "/control/v1/oauth/token" },
  { channel: "control-mcp.ts", method: "GET", path: "/control/v1/oauth/authorize" },
  { channel: "acme.ts", method: "POST", path: "/eve/v1/acme" },
];
const ARMING_UNDER_TEST: readonly ChannelArming[] = [
  {
    channel: "control-mcp.ts",
    armed: (env: NodeJS.ProcessEnv) => (env.TEST_ARMED ?? "") === "yes",
    darkReason: "dark by declaration: TEST_ARMED unset",
  },
];

check("a DARK channel's POST route is SKIPPED with its arming reason, never required (OPE-1674)", () => {
  const plan = planRequiredEndpoints({ routes: DARK_ROUTES, hooks: [], controlHookId: "none", env: {}, arming: ARMING_UNDER_TEST });
  assert.equal(
    plan.endpoints.some((e) => e.path === "/control/v1/oauth/token"),
    false,
    "the dark route must not be probed — its 404 is the shipped design",
  );
  const skipped = plan.skipped.find((s) => s.path === "/control/v1/oauth/token");
  assert.match(skipped?.reason ?? "", /dark by declaration/u, "and the skip must say WHY, so an operator can arm it");
  assert.ok(
    plan.endpoints.some((e) => e.path === "/eve/v1/acme"),
    "…while an unrelated channel's ingress is required exactly as before",
  );
});

check("the SAME route is REQUIRED once the arming condition holds — the skip narrows nothing permanently", () => {
  const plan = planRequiredEndpoints({
    routes: DARK_ROUTES,
    hooks: [],
    controlHookId: "none",
    env: { TEST_ARMED: "yes" },
    arming: ARMING_UNDER_TEST,
  });
  const required = plan.endpoints.find((e) => e.path === "/control/v1/oauth/token");
  assert.equal(required?.expect, "mounted", "an armed plane must answer, so a 404 there is still a red");
  assert.equal(
    plan.skipped.some((s) => s.path === "/control/v1/oauth/token"),
    false,
    "and it is no longer skipped",
  );
});

check("the SHIPPED arming table names control-mcp.ts and reads the signing secret the channel itself reads", () => {
  const entry = ROUTE_ARMING.find((a) => a.channel === "control-mcp.ts");
  assert.ok(entry, "the control plane's entry must exist — it is the channel that ships dark");
  assert.equal(entry!.armed({}), false, "an empty environment cannot arm it");
  assert.match(entry!.darkReason, new RegExp(OAUTH_SIGNING_SECRET_ENV, "u"), "the reason must name what to set");
});

check("every channel the arming table names is a real mounted channel file", () => {
  for (const entry of ROUTE_ARMING) {
    assert.ok(
      existsSync(join(dirname(fileURLToPath(import.meta.url)), "..", "agent", "channels", entry.channel)),
      `ROUTE_ARMING names agent/channels/${entry.channel}, and no such file exists — the entry can never match a route, so the census would ` +
        `require that channel's dark routes again. Fix the key, or drop the entry if the channel is gone`,
    );
  }
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

check("cronCeilingHours: a daily cron gets a ~26h ceiling", () => {
  assert.equal(cronCeilingHours("0 3 * * *"), 26);
});

check("cronCeilingHours: a weekly cron gets a ~172h ceiling", () => {
  assert.equal(cronCeilingHours("0 5 * * 1"), 172);
});

check("cronCeilingHours: an unrecognised shape FAILS LOUD rather than guessing a bound", () => {
  assert.throws(() => cronCeilingHours("*/10 * * * *"), /neither a daily nor a weekly pattern/u);
});

const NOW = new Date("2026-08-16T12:00:00Z");
const GATED = [
  { action: "identity.directory.sync", reason: "the daily directory-sync cron always heartbeats now (OPE-635)", maxAgeHours: 26 },
  { action: "memory.tidy_tick", reason: "the daily tidy cron always heartbeats now (OPE-635)", maxAgeHours: 26 },
];
const REPORTED = [{ action: "routine.fire", reason: "only fires when a routine is due — absence is legitimate" }];

check("heartbeatFindings: 🔴 THE INCIDENT IN MINIATURE — a gated action with NO row goes red", () => {
  const findings = heartbeatFindings({ gated: GATED, reported: [], observations: [], now: NOW });
  assert.equal(findings.every((h) => h.ok === false), true, "both gated actions read back false with no row at all");
  assert.equal(findings[0]?.ageHours, undefined, "no row ⇒ no age to report");
});

check("heartbeatFindings: a gated action with a row OLDER than its ceiling goes red, and names the age", () => {
  const stale = new Date(NOW.getTime() - 30 * 3_600_000).toISOString();
  const findings = heartbeatFindings({ gated: GATED, reported: [], observations: [{ action: "identity.directory.sync", lastSeenIso: stale }], now: NOW });
  const row = findings.find((h) => h.action === "identity.directory.sync")!;
  assert.equal(row.ok, false, "30h old is past the 26h ceiling");
  assert.ok(row.ageHours !== undefined && row.ageHours > 29.9 && row.ageHours < 30.1, "the age is reported, not just the verdict");
});

check("heartbeatFindings: a gated action with a FRESH row is green — the positive control", () => {
  const fresh = new Date(NOW.getTime() - 3 * 3_600_000).toISOString();
  const findings = heartbeatFindings({ gated: GATED, reported: [], observations: [{ action: "identity.directory.sync", lastSeenIso: fresh }], now: NOW });
  assert.equal(findings.find((h) => h.action === "identity.directory.sync")?.ok, true);
});

check("heartbeatFindings: a REPORTED action with NO row is still green — absence is a legitimate state, not a dead cron", () => {
  const findings = heartbeatFindings({ gated: [], reported: REPORTED, observations: [], now: NOW });
  assert.equal(findings[0]?.ok, true, "routine.fire never gates on absence");
  assert.equal(findings[0]?.maxAgeHours, undefined, "…and carries no bound, so the report never implies one");
});

check("heartbeatFindings: a REPORTED action WITH a row still reports its age (never gates, but the number is there)", () => {
  const seen = new Date(NOW.getTime() - 40 * 3_600_000).toISOString();
  const findings = heartbeatFindings({ gated: [], reported: REPORTED, observations: [{ action: "routine.fire", lastSeenIso: seen }], now: NOW });
  assert.equal(findings[0]?.ok, true, "still never gates, however old");
  assert.ok(findings[0]?.ageHours !== undefined && findings[0].ageHours > 39.9, "…but the age is there for an operator to read");
});

check("censusResult: a stale GATED heartbeat alone fails the whole census, even with every credential and route clean", () => {
  const staleFindings = heartbeatFindings({ gated: GATED, reported: [], observations: [], now: NOW });
  const result = clean({ heartbeats: staleFindings });
  assert.equal(result.ok, false, "a dead cron fails the census on its own");
  const report = renderCensusReport(result).join("\n");
  assert.match(report, /CRON HEARTBEATS \(0\/2 as expected\)/u);
  assert.match(report, /cron\(s\) with no fresh heartbeat: identity\.directory\.sync, memory\.tidy_tick/u);
});

check("censusResult: fresh GATED heartbeats + a REPORTED one with no row is still a clean census", () => {
  const fresh = new Date(NOW.getTime() - 1 * 3_600_000).toISOString();
  const okFindings = heartbeatFindings({
    gated: GATED,
    reported: REPORTED,
    observations: [
      { action: "identity.directory.sync", lastSeenIso: fresh },
      { action: "memory.tidy_tick", lastSeenIso: fresh },
    ],
    now: NOW,
  });
  const result = clean({ heartbeats: okFindings });
  assert.equal(result.ok, true, "every gate passes, and the report-only action's absence never counts against it");
  assert.match(renderCensusReport(result).join("\n"), /CRON HEARTBEATS \(3\/3 as expected\)/u);
});

check("censusResult: no `heartbeats` passed at all is byte-identical to today — the half is additive, never a silent new gate", () => {
  const result = clean();
  assert.equal(result.heartbeats.length, 0);
  assert.equal(result.ok, true);
  assert.doesNotMatch(renderCensusReport(result).join("\n"), /CRON HEARTBEATS/u);
});

check("runtimeSignalFinding: hasDeploymentId true is green and names the SIGNAL, not the consequence", () => {
  const f = runtimeSignalFinding({ hasDeploymentId: true });
  assert.equal(f.ok, true);
  assert.match(f.detail, /non-empty VERCEL_DEPLOYMENT_ID/u);
  assert.match(f.detail, /SIGNAL only/u, "the finding itself disclaims the consequence it does not prove");
});

check("runtimeSignalFinding: hasDeploymentId false is red — the incident this half exists to catch", () => {
  const f = runtimeSignalFinding({ hasDeploymentId: false });
  assert.equal(f.ok, false);
  assert.match(f.detail, /EMPTY/u);
});

check("runtimeSignalFinding: 🔴 ANTI-VACUITY — an UNREACHABLE route (undefined) is ALSO red, never a silent pass", () => {
  const f = runtimeSignalFinding(undefined);
  assert.equal(f.ok, false, "an unproven signal must never read as green by omission");
  assert.match(f.detail, /did not answer/u);
});

check("censusResult: a red runtimeSignal alone fails the whole census, even with every credential and route clean", () => {
  const result = clean({ runtimeSignal: runtimeSignalFinding({ hasDeploymentId: false }) });
  assert.equal(result.ok, false, "an empty VERCEL_DEPLOYMENT_ID fails the census on its own");
  const report = renderCensusReport(result).join("\n");
  assert.match(report, /RUNTIME-REVISION SIGNAL \(OPE-658\)/u);
  assert.match(report, /runtime-revision signal: .*EMPTY/u, "the red summary names the finding, not just a generic failure");
});

check("censusResult: a green runtimeSignal alongside a clean credential/route census is still a clean census", () => {
  const result = clean({ runtimeSignal: runtimeSignalFinding({ hasDeploymentId: true }) });
  assert.equal(result.ok, true);
  assert.match(renderCensusReport(result).join("\n"), /✓ .*non-empty VERCEL_DEPLOYMENT_ID/u);
});

check("censusResult: no `runtimeSignal` passed at all is byte-identical to today — the half is additive, never a silent new gate", () => {
  const result = clean();
  assert.equal(result.runtimeSignal, undefined);
  assert.equal(result.ok, true);
  assert.doesNotMatch(renderCensusReport(result).join("\n"), /RUNTIME-REVISION SIGNAL/u);
});

check("credentialBrokerArmedFinding: credentialBrokerArmed true is green and names what registers", () => {
  const f = credentialBrokerArmedFinding({ credentialBrokerArmed: true });
  assert.equal(f.ok, true);
  assert.match(f.detail, /valid OE_CREDENTIAL_ENCRYPTION_KEY/u);
});

check("credentialBrokerArmedFinding: credentialBrokerArmed false is red — the OPE-641 incident this half exists to catch", () => {
  const f = credentialBrokerArmedFinding({ credentialBrokerArmed: false });
  assert.equal(f.ok, false);
  assert.match(f.detail, /absent or malformed/u);
  assert.match(f.detail, /fails closed at once/u);
});

check("credentialBrokerArmedFinding: 🔴 ANTI-VACUITY — an UNREACHABLE route (undefined) is ALSO red, never a silent pass", () => {
  const f = credentialBrokerArmedFinding(undefined);
  assert.equal(f.ok, false, "an unproven signal must never read as green by omission");
  assert.match(f.detail, /did not answer/u);
});

check("censusResult: a red credentialBrokerArmed alone fails the whole census, even with every credential and route clean", () => {
  const result = clean({ credentialBrokerArmed: credentialBrokerArmedFinding({ credentialBrokerArmed: false }) });
  assert.equal(result.ok, false, "an unarmed deployment key fails the census on its own");
  const report = renderCensusReport(result).join("\n");
  assert.match(report, /CREDENTIAL BROKER KEY, DEPLOYMENT'S OWN \(OPE-641\)/u);
  assert.match(report, /credential broker key \(deployment\): .*fails closed/u, "the red summary names the finding, not just a generic failure");
});

check("censusResult: a green credentialBrokerArmed alongside a clean credential/route census is still a clean census", () => {
  const result = clean({ credentialBrokerArmed: credentialBrokerArmedFinding({ credentialBrokerArmed: true }) });
  assert.equal(result.ok, true);
  assert.match(renderCensusReport(result).join("\n"), /✓ .*valid OE_CREDENTIAL_ENCRYPTION_KEY/u);
});

check("censusResult: no `credentialBrokerArmed` passed at all is byte-identical to today — the half is additive, never a silent new gate", () => {
  const result = clean();
  assert.equal(result.credentialBrokerArmed, undefined);
  assert.equal(result.ok, true);
  assert.doesNotMatch(renderCensusReport(result).join("\n"), /CREDENTIAL BROKER KEY/u);
});

check("channelCensusContributions: the mounted Discord gateway contributes its caveat AND the one REPORTED relay heartbeat", () => {
  const got = channelCensusContributions(["discord-gateway.ts", "slack.ts", "notion.ts"]);
  assert.equal(got.reportedHeartbeats.length, 1, "one reported heartbeat — discord.heartbeat is now GATED, not reported");
  assert.deepEqual(got.reportedHeartbeats.map((h) => h.action), ["discord.dispatched"]);
  assert.equal(got.limits.length, 1, "one caveat, from the same channel");
  assert.match(got.limits[0] ?? "", /discord-relay/u, "…and it names the always-on relay it cannot see directly");
  assert.match(got.limits[0] ?? "", /discord\.dispatched/u, "the caveat names the reported, never-gated signal");
  assert.match(got.limits[0] ?? "", /discord\.heartbeat/u, "…and the now-GATED OPE-775 signal");
  assert.match(got.limits[0] ?? "", /OPE-785/u, "…and points at this ticket for the promotion");
});

check("channelCensusContributions: a DESELECTED gateway contributes NOTHING — no caveat, no heartbeat", () => {
  const got = channelCensusContributions(["slack.ts", "notion.ts", "linear.ts"]);
  assert.deepEqual(got.reportedHeartbeats, [], "a deploy with no Discord reports no relay age");
  assert.deepEqual(got.limits, [], "…and carries no caveat about a relay it does not run");
});

check("channelCensusContributions: an unknown channel module contributes nothing rather than throwing", () => {
  const got = channelCensusContributions(["some-future-provider.ts"]);
  assert.deepEqual(got.limits, []);
  assert.deepEqual(got.reportedHeartbeats, []);
});

check("OPE-640 anti-vacuity: discord.dispatched stays REPORTED — a quiet guild never fails the census", () => {
  const reported = channelCensusContributions(["discord-gateway.ts"]).reportedHeartbeats;
  const silent = heartbeatFindings({ gated: [], reported, observations: [], now: NOW });
  assert.equal(silent.length, 1);
  assert.equal(silent[0]?.ok, true, "absence never fails — gating here would red every quiet weekend");
  assert.equal(silent[0]?.ageHours, undefined, "…and reports no age it does not have");
  assert.equal(clean({ heartbeats: silent }).ok, true, "…so the census verdict is untouched");
  const seen = new Date(NOW.getTime() - 9 * 3_600_000).toISOString();
  const aged = heartbeatFindings({ gated: [], reported, observations: [{ action: "discord.dispatched", lastSeenIso: seen }], now: NOW });
  assert.ok(aged[0]?.ageHours !== undefined && aged[0].ageHours > 8.9 && aged[0].ageHours < 9.1, "the age IS reported when a row exists");
  assert.equal(aged[0]?.ok, true, "…and it still never gates, however old it is");
});

check("relayHeartbeatCeilingHours: derives interval×3 (the beat plus two missed beats) — the relay's own 5min default", () => {
  assert.equal(relayHeartbeatCeilingHours(300_000), 0.25, "300_000ms × 3 = 900_000ms = 0.25h");
  assert.equal(relayHeartbeatCeilingHours(3_600_000), 3, "a 1h interval ceils at 3h");
});

for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
  check(`relayHeartbeatCeilingHours: throws rather than guess a bound for a non-positive interval (${bad})`, () => {
    assert.throws(() => relayHeartbeatCeilingHours(bad), /positive number of milliseconds/u);
  });
}

check("channelGatedHeartbeats: the mounted Discord gateway contributes ONE gated discord.heartbeat entry, ceiling derived from the interval passed in", () => {
  const got = channelGatedHeartbeats(["discord-gateway.ts", "slack.ts"], 300_000);
  assert.equal(got.length, 1);
  assert.equal(got[0]?.action, "discord.heartbeat");
  assert.equal(got[0]?.maxAgeHours, relayHeartbeatCeilingHours(300_000), "the ceiling is DERIVED, not hand-typed, from the same interval");
});

check("channelGatedHeartbeats: a DESELECTED gateway contributes NOTHING", () => {
  assert.deepEqual(channelGatedHeartbeats(["slack.ts", "notion.ts"], 300_000), []);
});

check("channelGatedHeartbeats: OE_RELAY_HEARTBEAT_MS=0 (the relay's own \"disabled\" value) contributes NOTHING — stays REPORTED-only", () => {
  assert.deepEqual(channelGatedHeartbeats(["discord-gateway.ts"], 0), [], "a deliberately-disabled relay heartbeat must not gate on a signal that will never arrive");
});

check("OPE-785: discord.heartbeat now GATES — a stale or missing row fails the census, joining independently of discord.dispatched", () => {
  const reported = channelCensusContributions(["discord-gateway.ts"]).reportedHeartbeats;
  const gated = channelGatedHeartbeats(["discord-gateway.ts"], 300_000);
  assert.equal(gated[0]?.action, "discord.heartbeat", "the gated plan carries the entry this test drives");

  const staleDispatch = new Date(NOW.getTime() - 96 * 3_600_000).toISOString();
  const freshHeartbeat = new Date(NOW.getTime() - 0.01 * 3_600_000).toISOString();
  const findings = heartbeatFindings({
    gated,
    reported,
    observations: [
      { action: "discord.dispatched", lastSeenIso: staleDispatch },
      { action: "discord.heartbeat", lastSeenIso: freshHeartbeat },
    ],
    now: NOW,
  });
  const dispatched = findings.find((f) => f.action === "discord.dispatched");
  const heartbeat = findings.find((f) => f.action === "discord.heartbeat");
  assert.ok(dispatched?.ageHours !== undefined && dispatched.ageHours > 95, "dispatched reads its OWN stale age, and never gates on it");
  assert.equal(dispatched?.ok, true, "discord.dispatched stays REPORTED — 96h stale does not fail it");
  assert.ok(heartbeat?.ageHours !== undefined && heartbeat.ageHours < 0.25, "heartbeat reads its OWN fresh age — a quiet guild does not stale it");
  assert.equal(heartbeat?.ok, true, "a FRESH heartbeat passes the gate — the positive control");
  assert.equal(clean({ heartbeats: findings }).ok, true, "…so the overall census verdict is clean");

  const staleHeartbeat = new Date(NOW.getTime() - 1 * 3_600_000).toISOString();
  const deadRelay = heartbeatFindings({
    gated,
    reported,
    observations: [
      { action: "discord.dispatched", lastSeenIso: staleDispatch },
      { action: "discord.heartbeat", lastSeenIso: staleHeartbeat },
    ],
    now: NOW,
  });
  const deadHeartbeat = deadRelay.find((f) => f.action === "discord.heartbeat");
  assert.equal(deadHeartbeat?.ok, false, "a stale discord.heartbeat now GATES — this is the promotion");
  assert.equal(clean({ heartbeats: deadRelay }).ok, false, "…and the overall census verdict goes red with it");

  const missingRow = heartbeatFindings({ gated, reported: [], observations: [], now: NOW });
  assert.equal(missingRow.find((f) => f.action === "discord.heartbeat")?.ok, false, "a MISSING discord.heartbeat row also gates red");
});

check("OPE-1731: the rendered discord.heartbeat red names the remedy AND the ingest-side cause, and does not credit the relay with the write", () => {
  const gated = channelGatedHeartbeats(["discord-gateway.ts"], 300_000);
  const findings = heartbeatFindings({ gated, reported: [], observations: [], now: NOW });
  const result = clean({ heartbeats: findings });
  assert.equal(result.ok, false, "a missing discord.heartbeat row reds the census — the precondition this red line exists for");

  const lines = renderCensusReport(result);
  const rowAt = lines.findIndex((l) => l.includes("✗ discord.heartbeat"));
  assert.notEqual(rowAt, -1, "the report prints a failing discord.heartbeat row");
  const gatedLine = lines[rowAt + 1] ?? "";

  assert.match(gatedLine, /Redeploy the Railway relay/u, "the red must tell the operator what to DO, not only what the signal means");
  assert.match(gatedLine, /bot-token rotation/u, "…and name the rotation that makes the redeploy necessary");
  assert.match(gatedLine, /docs\/deploy\/surfaces\/discord\.md/u, "…pointing at the doc that carries the procedure");
  assert.match(gatedLine, /Rotating the bot token/u, "…at its section by name");

  assert.match(gatedLine, /OE_RELAY_SECRET/u, "the ingest-side cause names the secret that must agree on both sides");
  assert.match(gatedLine, /401/u, "…and what a mismatch actually answers");
  assert.match(gatedLine, /Rule this one out FIRST/u, "…and says to rule it out before redeploying, which is the ordering that saves the wasted redeploy");

  assert.match(gatedLine, /not the whole list/u, "the red must not claim its two causes are exhaustive");
  assert.match(gatedLine, /fire-and-forget/u, "…and must name the swallowed append as the reason it is not");

  assert.doesNotMatch(gatedLine, /written by the always-on Discord relay/u, "the relay does not write the row — that claim sent readers to the wrong remedy");
  assert.match(gatedLine, /relay \(deploy\/discord-relay\/\) POSTs this heartbeat/u, "the relay POSTs");
  assert.match(gatedLine, /DEPLOYMENT appends the row/u, "the deployment appends");

  const green = clean({
    heartbeats: heartbeatFindings({
      gated,
      reported: [],
      observations: [{ action: "discord.heartbeat", lastSeenIso: new Date(NOW.getTime() - 60_000).toISOString() }],
      now: NOW,
    }),
  });
  assert.equal(green.ok, true, "a fresh row is green — the positive control for this render");
  assert.doesNotMatch(renderCensusReport(green).join("\n"), /Redeploy the Railway relay/u, "a green census never prints the remedy");
});

{
  const { initOperationalSchema } = await import("../packages/core/agent/operational/postgres.js");
  type PgClient = import("../packages/core/agent/operational/postgres.js").PgClient;
  const { _resetDeploymentIdentityForTest, registerDeploymentIdentity, registeredDeploymentIdentity } = await import(
    "../packages/core/agent/identity/deployment-identity.js"
  );
  const { openCensusStore } = await import("./deploy/census-store.js");

  const HOSTED = { id: "postgres", label: "hosted Postgres (DATABASE_URL)" } as const;

  function stubStore(): { connect: () => Promise<typeof HOSTED>; integrityOrgs: string[] } {
    const integrityOrgs: string[] = [];
    const client: PgClient = {
      query: async (text: string, params?: readonly unknown[]) => {
        if (text.includes("pg_has_role")) return { rows: [{ is_owner: false }] };
        if (text.includes("relrowsecurity")) return { rows: [] };
        if (text.includes("INSERT INTO audit_entry")) {
          integrityOrgs.push(String(params?.[1]));
          return { rows: [] };
        }
        return { rows: [] };
      },
    };
    return {
      integrityOrgs,
      connect: async () => {
        try {
          await initOperationalSchema(client);
        } catch {
        }
        return HOSTED;
      },
    };
  }

  const savedIdentity = registeredDeploymentIdentity();
  let declaredOrgs: string[] = [];
  let declaredResultOrg = "";
  let bareOrgs: string[] = [];
  let bareResultOrg = "";
  let floorRefusal: string | null = null;
  try {
    _resetDeploymentIdentityForTest();
    const declared = stubStore();
    declaredResultOrg = (await openCensusStore("acme", declared.connect)).org;
    declaredOrgs = declared.integrityOrgs;

    _resetDeploymentIdentityForTest();
    const bare = stubStore();
    bareResultOrg = (await openCensusStore(undefined, bare.connect)).org;
    bareOrgs = bare.integrityOrgs;

    _resetDeploymentIdentityForTest();
    try {
      await openCensusStore("acme", async () => ({ id: "postgres", label: "embedded Postgres floor (PGlite, local data dir)" }));
    } catch (err) {
      floorRefusal = err instanceof Error ? err.message : String(err);
    }
  } finally {
    if (savedIdentity) registerDeploymentIdentity(savedIdentity);
    else _resetDeploymentIdentityForTest();
  }

  check("OPE-1587: --org is declared BEFORE the store opens, so the integrity row carries it", () => {
    assert.equal(declaredOrgs.length, 1, "positive control: the schema init really wrote one audit.integrity row");
    assert.equal(declaredOrgs[0], "acme", "the integrity row is filed under the org named on the command line");
    assert.equal(declaredResultOrg, "acme", "…and the census reads the same org it wrote under");
  });

  check("OPE-1587: with no --org the row falls back to the shipped default", () => {
    assert.equal(bareOrgs.length, 1, "positive control: the no-flag run wrote an integrity row too");
    assert.equal(bareOrgs[0], "default", "an undeclared operator process is the shipped \"default\"");
    assert.equal(bareResultOrg, "default", "…and reads that partition");
  });

  check("OPE-1587: a floor store is still refused, by name", () => {
    assert.ok(floorRefusal !== null, "a store that is not the deployment's own throws");
    assert.match(String(floorRefusal), /embedded Postgres floor/, "…and the refusal names the store it opened");
  });

  const readSource = (await import("node:fs")).readFileSync;
  const ENTRIES = [
    {
      file: "scripts/deploy/census.ts",
      label: "the census entry opens its store through its rung",
      requires: /openCensusStore\(/,
      forbids: /\bconnectOperatorStore\s*\(/,
    },
    {
      file: "packages/core/agent/ops/server.ts",
      label: "the ops MCP server declares the org before it connects",
      requires: /declareOperatorOrg\([\s\S]*?connectOperatorStore\(/,
      forbids: /connectOperatorStore\([\s\S]*?declareOperatorOrg\(/,
    },
  ] as const;
  for (const entry of ENTRIES) {
    const code = readSource(entry.file, "utf8").replace(/^\s*\/\/.*$/gm, "");
    check(`OPE-1587: ${entry.label}`, () => {
      assert.match(code, entry.requires, `${entry.file} declares the org, then connects`);
      assert.doesNotMatch(code, entry.forbids, `${entry.file} holds no connect that runs before a declaration`);
    });
  }
}

if (failures.length > 0) {
  console.error(`✗ deploy-census: ${failures.length} of ${checks} check(s) FAILED`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`✓ deploy-census: ${checks} check(s) passed (required-set derivation, endpoint plan, the four reds, the anti-vacuity control, the OPE-635 cron heartbeat half, the OPE-658 runtime-revision signal half, the OPE-641 credential-broker-armed half, the OPE-640 channel contributions, the OPE-775/OPE-785 relay heartbeat half now GATED — all offline)`);
