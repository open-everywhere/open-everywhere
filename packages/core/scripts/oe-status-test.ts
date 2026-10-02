import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  HOST_ROUTES,
  OE_STATUS_PATH,
  STATUS_CACHE_MS,
  _resetStatusRegistriesForTest,
  cachedDeploymentStatus,
  deploymentStatus,
  hostRoute,
  invalidateStatusCache,
  registerStatusProbe,
  registerSurfaceStatusReporter,
  type DeploymentStatus,
  type RequirementStatus,
} from "../agent/ops/status.js";
import { CONTRACT_NODE_RANGE, CONTRACT_REQUIREMENT_IDS, CONTRACT_ROUTES, CONTRACT_VERSION } from "../agent/ops/contract.js";
import { registerAppInfo, resetAppInfo } from "../agent/commands/app-info.js";
import { CORE_PACKAGE_VERSION } from "../agent/ops/package-info.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const HEALTHY_ENV: NodeJS.ProcessEnv = {
  DATABASE_URL: "postgres://oe_runtime:pw@db.example.invalid/neondb",
  OE_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  OE_PUBLIC_BASE_URL: "https://oe.example.invalid",
  OE_EGRESS_PROXY_URL: "http://127.0.0.1:8888",
};

const BASE = { nodeVersion: "24.21.0", nodeRange: "24.x", version: { app: "1.2.3", core: "0.1.2", eve: "0.54.3" }, host: "self-host" } as const;

const req = (doc: DeploymentStatus, id: string): RequirementStatus => {
  const row = doc.requirements.find((r) => r.id === id);
  assert.ok(row, `no requirement row for ${id}`);
  return row;
};

{
  _resetStatusRegistriesForTest();
  const doc = await deploymentStatus({ ...BASE, env: HEALTHY_ENV });
  ok(OE_STATUS_PATH === "/eve/v1/oe/status", "the route is the one the ticket and the docs name");
  ok(doc.contract === CONTRACT_VERSION, "the payload carries the contract version it answers");
  ok(doc.version.core === "0.1.2" && doc.version.app === "1.2.3" && doc.version.eve === "0.54.3", "the payload carries all three version facts");
  ok(doc.host === "self-host", "the payload carries the host route from the platform seam");
  ok(
    doc.requirements.map((r) => r.id).join(",") === CONTRACT_REQUIREMENT_IDS.join(","),
    "every requirement id, exactly once, in the contract's own order",
  );
  ok(typeof doc.checkedAt === "string" && !Number.isNaN(Date.parse(doc.checkedAt)), "checkedAt is an ISO instant");
  ok(doc.requirements.every((r) => ["yes", "no", "unknown"].includes(r.met)), "every verdict is in the closed vocabulary");
  ok(doc.requirements.every((r) => r.detail.trim().length > 0), "every verdict carries a sentence of English");
}

{
  resetAppInfo();
  const live = await deploymentStatus({ nodeVersion: "24.21.0", env: HEALTHY_ENV, host: "self-host", probes: {} });
  ok(live.version.app === null && live.version.eve === null, "an app that never registered reads null for app and eve, never \"unknown\"");
  registerAppInfo({ version: "0.0.0", primaryModel: "m", utilityModel: "m", deploymentSha: "abc", evePin: "0.54.3" });
  const registered = await deploymentStatus({ nodeVersion: "24.21.0", env: HEALTHY_ENV, host: "self-host", probes: {} });
  ok(registered.version.eve === "0.54.3", "a registered app's eve pin reaches the payload");
  ok(registered.version.app === "unversioned", "…and an unbumped root version reads `unversioned`, the word the fact bag normalises to");
  ok(!JSON.stringify(registered).includes("abc"), "🔴 the deployment commit sha is NOT in the public payload (no id)");
  ok(req(registered, "node-24").met === "yes", "node: the default range is the contract's own literal, which a bundled server still carries");
  ok(req(registered, "node-24").detail.includes(CONTRACT_NODE_RANGE), "node: …and the detail names it");

  const serialised = JSON.parse(JSON.stringify(registered)) as { version: { core: unknown } };
  ok(serialised.version.core !== null, "🔴 version.core is not null in the serialised payload — the field a deployed bundle published as null");
  ok(
    typeof serialised.version.core === "string" && serialised.version.core.length > 0,
    "…it is a non-empty version string",
  );
  ok(serialised.version.core === CORE_PACKAGE_VERSION, "…and it is exactly the constant the bundle carries");

  const coreManifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
  ok(
    coreManifest.version === CORE_PACKAGE_VERSION,
    `🔴 CORE_PACKAGE_VERSION (${CORE_PACKAGE_VERSION}) must equal packages/core/package.json's version (${String(coreManifest.version)}) — a release bumps both in the same commit`,
  );
  resetAppInfo();
}

{
  ok(hostRoute("vercel") === "vercel", "host: vercel passes through");
  ok(hostRoute("docker") === "docker", "host: docker passes through — the contract's other proven route");
  ok(hostRoute("self-host") === "self-host", "host: the generic passes through");
  ok(hostRoute(" Docker ") === "docker", "host: trimmed and lower-cased, like the platform seam itself");
  ok(hostRoute("acme-prod-cluster-7") === "self-host", "🔴 host: an operator's own label is NARROWED, never published");
  ok(
    CONTRACT_ROUTES.every((r) => (HOST_ROUTES as readonly string[]).includes(r)),
    "host: every PROVEN contract route is a host route",
  );
  ok(HOST_ROUTES.length === CONTRACT_ROUTES.length + 1, "…and the only extra is the generic residue");
  ok(!(CONTRACT_ROUTES as readonly string[]).includes("self-host"), "…which is NOT itself a contract route — an agent joining it to contract.json finds no entry");
}

{
  const healthy = await deploymentStatus({ ...BASE, env: HEALTHY_ENV, probes: {} });
  ok(req(healthy, "node-24").met === "yes", "node: a satisfying version reads yes");
  ok(req(healthy, "public-https-url").met === "yes", "public url: OE_PUBLIC_BASE_URL reads yes");
  ok(req(healthy, "public-https-url").detail.includes("OE_PUBLIC_BASE_URL"), "public url: names the SOURCE it resolved from");
  ok(req(healthy, "sandbox-backend").met === "yes", "sandbox: the docker default reads yes off Vercel");
  ok(req(healthy, "egress-control").met === "yes", "egress: a wired proxy reads yes off Vercel");
  ok(req(healthy, "secrets").met === "yes", "secrets: both root-of-trust values present reads yes");

  const old = await deploymentStatus({ ...BASE, env: HEALTHY_ENV, nodeVersion: "22.22.0", probes: {} });
  ok(req(old, "node-24").met === "no", "node: an unsatisfying version reads no");
  const noRange = await deploymentStatus({ ...BASE, env: HEALTHY_ENV, nodeRange: "not-a-range", probes: {} });
  ok(req(noRange, "node-24").met === "unknown", "node: an unparseable engines range reads unknown, never no");

  const noUrl = await deploymentStatus({ ...BASE, env: { ...HEALTHY_ENV, OE_PUBLIC_BASE_URL: "" }, probes: {} });
  ok(req(noUrl, "public-https-url").met === "no", "public url: undiscoverable reads no");
  const httpUrl = await deploymentStatus({ ...BASE, env: { ...HEALTHY_ENV, OE_PUBLIC_BASE_URL: "http://localhost:3000" }, probes: {} });
  ok(req(httpUrl, "public-https-url").met === "no", "public url: a resolvable but non-https origin reads no");
  ok(req(httpUrl, "public-https-url").detail.includes("not https"), "public url: …and the detail says which half failed");
  const bareHost = await deploymentStatus({ ...BASE, env: { ...HEALTHY_ENV, OE_PUBLIC_BASE_URL: "oe.example.invalid" }, probes: {} });
  ok(req(bareHost, "public-https-url").met === "yes", "public url: a bare host gets https:// and reads yes (negative control for the arm above)");
  const shoutyScheme = await deploymentStatus({ ...BASE, env: { ...HEALTHY_ENV, OE_PUBLIC_BASE_URL: "HTTPS://oe.example.invalid" }, probes: {} });
  ok(req(shoutyScheme, "public-https-url").met === "yes", "public url: HTTPS:// is https — a working origin must not read no");

  const vercelUrl = await deploymentStatus({
    ...BASE,
    env: { ...HEALTHY_ENV, OE_PUBLIC_BASE_URL: "", VERCEL_PROJECT_PRODUCTION_URL: "oe.vercel.app" },
    probes: {},
  });
  ok(req(vercelUrl, "public-https-url").met === "yes", "public url: the Vercel production alias reads yes");

  const justbash = await deploymentStatus({ ...BASE, env: { ...HEALTHY_ENV, OE_SANDBOX_BACKEND: "justbash" }, probes: {} });
  ok(req(justbash, "sandbox-backend").met === "no", "sandbox: justbash shares the app filesystem and reads no");
  const badBackend = await deploymentStatus({ ...BASE, env: { ...HEALTHY_ENV, OE_SANDBOX_BACKEND: "wat" }, probes: {} });
  ok(req(badBackend, "sandbox-backend").met === "no", "sandbox: an unknown backend reads no (the app refuses to boot on it)");

  const noProxy = { ...HEALTHY_ENV, OE_EGRESS_PROXY_URL: "" };
  const failClosed = await deploymentStatus({ ...BASE, env: noProxy, probes: {} });
  ok(req(failClosed, "egress-control").met === "no", "egress: no proxy and no declaration reads no");
  ok(req(failClosed, "egress-control").detail.includes("fail-closed"), "egress: says the session aborts rather than run unfirewalled");
  const declared = await deploymentStatus({ ...BASE, env: noProxy, allowUnenforced: true, probes: {} });
  ok(req(declared, "egress-control").met === "no", "egress: a DECLARED unenforced posture still reads no — it is not enforcement");

  const noKey = await deploymentStatus({ ...BASE, env: { ...HEALTHY_ENV, OE_CREDENTIAL_ENCRYPTION_KEY: "" }, probes: {} });
  ok(req(noKey, "secrets").met === "no", "secrets: an absent credential key reads no");
  const shortKey = await deploymentStatus({ ...BASE, env: { ...HEALTHY_ENV, OE_CREDENTIAL_ENCRYPTION_KEY: "dG9vLXNob3J0" }, probes: {} });
  ok(req(shortKey, "secrets").met === "no", "secrets: a key that does not decode to 32 bytes reads no");
  ok(req(shortKey, "secrets").detail.includes("32-byte"), "secrets: says WHY a malformed key is refused");

  const onVercel = await deploymentStatus({ ...BASE, host: "vercel", env: { ...HEALTHY_ENV, OE_EGRESS_PROXY_URL: "" }, probes: {} });
  ok(req(onVercel, "sandbox-backend").met === "yes", "vercel: the Vercel Sandbox satisfies the sandbox requirement");
  ok(req(onVercel, "egress-control").met === "yes", "vercel: the platform firewall satisfies egress control");
  ok(req(onVercel, "workflow-storage").met === "yes", "vercel: Vercel Workflow satisfies durable run storage");
}

{
  const bareUrl = await deploymentStatus({ ...BASE, env: { DATABASE_URL: "postgres://x/y" }, probes: {} });
  ok(
    req(bareUrl, "postgres").detail.includes("selected for both stores"),
    "store: a bare DATABASE_URL — no selector — IS a hosted postgres selection for both stores",
  );
  const floor = await deploymentStatus({ ...BASE, env: {}, probes: {} });
  ok(req(floor, "postgres").met === "no", "store: no DATABASE_URL reads no");
  ok(req(floor, "postgres").detail.includes("PGlite"), "store: names the embedded floor it fell to");
  const pointedAway = await deploymentStatus({ ...BASE, env: { DATABASE_URL: "postgres://x/y", OE_MEMORY_PROVIDER: "git" }, probes: {} });
  ok(req(pointedAway, "postgres").met === "no", "store: a selector pointed away from postgres still overrides the default, and reads no");

  const reachable = await deploymentStatus({
    ...BASE,
    env: HEALTHY_ENV,
    probes: { postgres: async () => ({ met: "yes", detail: "the store answered a read" }) },
  });
  ok(req(reachable, "postgres").met === "yes", "store: a reachable probe over a hosted selection reads yes");
  const unreachable = await deploymentStatus({
    ...BASE,
    env: HEALTHY_ENV,
    probes: { postgres: async () => ({ met: "no", detail: "the store did not answer a read" }) },
  });
  ok(req(unreachable, "postgres").met === "no", "store: an unreachable probe reads no even though the selection is right");
}

{
  let floorProbeRuns = 0;
  const floorDoc = await deploymentStatus({
    ...BASE,
    env: {},
    probes: {
      postgres: async () => {
        floorProbeRuns++;
        return { met: "yes", detail: "the store answered a read" };
      },
    },
  });
  ok(floorProbeRuns === 0, "no hosted postgres selected ⇒ the database probe is NOT run at all");
  ok(req(floorDoc, "postgres").met === "no", "…and the verdict still comes from the selection");
  let hostedProbeRuns = 0;
  await deploymentStatus({
    ...BASE,
    env: HEALTHY_ENV,
    probes: {
      postgres: async () => {
        hostedProbeRuns++;
        return { met: "yes", detail: "the store answered a read" };
      },
    },
  });
  ok(hostedProbeRuns === 1, "hosted postgres selected ⇒ the probe IS run (the negative control)");

  const unprobed = await deploymentStatus({ ...BASE, env: HEALTHY_ENV, probes: {} });
  ok(req(unprobed, "postgres").met === "unknown", "no database probe registered ⇒ unknown, never no");
  ok(req(unprobed, "model-route").met === "unknown", "no model probe registered ⇒ unknown, never no");
  ok(req(unprobed, "workflow-storage").met === "unknown", "off Vercel, run-storage durability is a host fact this process cannot read");

  const thrower = await deploymentStatus({
    ...BASE,
    env: HEALTHY_ENV,
    probes: {
      postgres: async () => {
        throw new Error("boom");
      },
    },
  });
  ok(req(thrower, "postgres").met === "unknown", "a THROWING probe reads unknown and does not fail the document");
  ok(!JSON.stringify(thrower).includes("boom"), "a throwing probe's error text never reaches the payload");

  const answered = await deploymentStatus({
    ...BASE,
    env: HEALTHY_ENV,
    probes: { "model-route": async () => ({ met: "yes", detail: "the model gateway answered a catalog read" }) },
  });
  ok(req(answered, "model-route").met === "yes", "model: a registered probe's answer is the verdict");
}

{
  const doc = await deploymentStatus({
    ...BASE,
    env: HEALTHY_ENV,
    probes: {},
    surfaceReporters: {
      slack: async () => ({ credentials: "yes", installed: "yes" }),
      teams: async () => {
        throw new Error("vendor down");
      },
    },
  });
  ok(doc.surfaces["slack"]?.credentials === "yes", "a reporter's answer lands under its platform");
  ok(doc.surfaces["slack"]?.eventsVerified === "unknown", "a field the reporter omits stays unknown");
  ok(doc.surfaces["teams"]?.credentials === "unknown", "a THROWING reporter reads unknown on every field");
  ok(!JSON.stringify(doc).includes("vendor down"), "a throwing reporter's error text never reaches the payload");
  ok(Object.keys(doc.surfaces).join(",") === "slack,teams", "surfaces are in a stable, sorted order");
  const none = await deploymentStatus({ ...BASE, env: HEALTHY_ENV, probes: {}, surfaceReporters: {} });
  ok(Object.keys(none.surfaces).length === 0, "a deployment with no registered surface reports none, rather than inventing one");
}

{
  const secret = "s3cr3t-DO-NOT-PUBLISH";
  const env: NodeJS.ProcessEnv = {
    DATABASE_URL: `postgres://oe_runtime:${secret}@db-prod-internal.example.invalid:5432/neondb`,
    OE_CREDENTIAL_ENCRYPTION_KEY: Buffer.from(`${secret}${secret}`.slice(0, 32), "utf8").toString("base64"),
    OE_PUBLIC_BASE_URL: "https://acme-internal.example.invalid",
    AI_GATEWAY_API_KEY: `gw-${secret}`,
    SLACK_BOT_TOKEN: `xoxb-${secret}`,
    OE_EGRESS_PROXY_URL: `http://proxy-internal.example.invalid:8888/${secret}`,
    VERCEL_PROJECT_PRODUCTION_URL: "acme-oe.vercel.app",
    OE_PLATFORM: `acme-${secret}-cluster`,
    OE_MEMORY_PROVIDER: `postgres://oe_runtime:${secret}@db-prod.internal/neondb`,
    OE_OPERATIONAL_PROVIDER: `acme-${secret}-store`,
  };
  const doc = await deploymentStatus({
    ...BASE,
    host: env.OE_PLATFORM,
    env,
    probes: { postgres: async () => ({ met: "yes", detail: "the store answered a read" }) },
    surfaceReporters: { slack: async () => ({ credentials: "yes", installed: "yes", eventsVerified: "yes" }) },
  });
  const wire = JSON.stringify(doc);
  ok(doc.host === "self-host", "🔴 an OE_PLATFORM label outside the contract's vocabulary is NARROWED to self-host, never echoed");
  ok(!wire.includes(secret), "no seeded secret's bytes appear anywhere in the payload");
  for (const [name, value] of Object.entries(env)) {
    ok(!wire.includes(value!), `no env VALUE appears in the payload (${name})`);
  }
  ok(!wire.includes("example.invalid"), "no hostname from any configured value appears in the payload");
  ok(!wire.includes("xoxb-"), "no credential prefix appears in the payload");
  ok(wire.includes("OE_PUBLIC_BASE_URL"), "an env NAME may appear — that is what makes a 'no' actionable");
}

{
  _resetStatusRegistriesForTest();
  let probed = 0;
  registerStatusProbe("postgres", async () => {
    probed++;
    return { met: "yes", detail: "the store answered a read" };
  });
  const at = 1_000_000;
  await cachedDeploymentStatus({ ...BASE, env: HEALTHY_ENV }, at);
  await cachedDeploymentStatus({ ...BASE, env: HEALTHY_ENV }, at + STATUS_CACHE_MS - 1);
  ok(probed === 1, "inside the window the document is served from the cache — one probe run, not two");
  await cachedDeploymentStatus({ ...BASE, env: HEALTHY_ENV }, at + STATUS_CACHE_MS);
  ok(probed === 2, "past the window the probes run again");

  invalidateStatusCache();
  _resetStatusRegistriesForTest();
  let concurrent = 0;
  registerStatusProbe("postgres", async () => {
    concurrent++;
    await new Promise((r) => setTimeout(r, 20));
    return { met: "yes", detail: "the store answered a read" };
  });
  const burst = await Promise.all(
    Array.from({ length: 8 }, () => cachedDeploymentStatus({ ...BASE, env: HEALTHY_ENV }, at + 2 * STATUS_CACHE_MS)),
  );
  ok(concurrent === 1, "eight concurrent callers drive ONE assembly, not eight");
  ok(burst.every((d) => d === burst[0]), "…and every one of them gets the same document object");
  registerSurfaceStatusReporter("slack", async () => ({ credentials: "yes" }));
  const after = await cachedDeploymentStatus({ ...BASE, env: HEALTHY_ENV }, at + STATUS_CACHE_MS);
  ok(after.surfaces["slack"] !== undefined, "a registration invalidates the cache, so a late boot arm is not hidden for a window");
  invalidateStatusCache();
  _resetStatusRegistriesForTest();
}

console.log(`✓ oe-status: ${n} assertions passed`);
