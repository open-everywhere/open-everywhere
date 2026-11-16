import assert from "node:assert/strict";
import { initOperationalSchema, makeOperationalPostgresStore, type PgClient } from "../agent/operational/postgres.js";
import { openTestPg, closeAllTestPg } from "./test-pg-driver.js";
import {
  evaluateStoreIdentity,
  resolveStoreIdentityGuardConfig,
  assertStoreIdentity,
  STORE_IDENTITY_MAX_DRIFT_MS,
  type FetchAuditFn,
} from "./store-identity-guard.js";

import { pinSuiteStore } from "./_suite-store.js";
pinSuiteStore("store-identity-guard");

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}
function eq(a: unknown, b: unknown, label: string): void {
  if (a !== b) {
    console.error(`✗ ${label}\n  actual:   ${JSON.stringify(a)}\n  expected: ${JSON.stringify(b)}`);
    process.exit(1);
  }
  passed++;
}
async function throws(label: string, fn: () => Promise<unknown>, messageIncludes: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ok(msg.includes(messageIncludes), `${label} — refusal message names the reason ("${messageIncludes}")\n  actual message: ${msg}`);
    return;
  }
  ok(false, `${label} — expected a throw, got none`);
}

const T0 = "2026-08-19T12:00:00.000Z";

{
  {
    const v = evaluateStoreIdentity({ localNewestTs: T0, remoteNewestTs: T0 }, STORE_IDENTITY_MAX_DRIFT_MS);
    ok(v.ok, "identical newest-row timestamps judge as the same store");
  }

  {
    const later = new Date(Date.parse(T0) + 2 * 60 * 1000).toISOString();
    const v = evaluateStoreIdentity({ localNewestTs: T0, remoteNewestTs: later }, STORE_IDENTITY_MAX_DRIFT_MS);
    ok(v.ok, "a 2-minute drift, under the 5-minute window, still passes");
  }

  {
    const stale = new Date(Date.parse(T0) - 30 * 60 * 60 * 1000).toISOString();
    const v = evaluateStoreIdentity({ localNewestTs: stale, remoteNewestTs: T0 }, STORE_IDENTITY_MAX_DRIFT_MS);
    ok(!v.ok, "🔴 a 30-hour divergence (a live run's own gap) is REFUSED, not judged as the same store");
    if (!v.ok) {
      ok(v.reason.includes("diverges"), "…and the reason names the divergence");
    }
    eq(v.ok, false, "negative control: ok is exactly false for a genuine divergence, not merely falsy");
  }

  {
    const bothOld = new Date(Date.parse(T0) - 12 * 60 * 60 * 1000).toISOString();
    const v = evaluateStoreIdentity({ localNewestTs: bothOld, remoteNewestTs: bothOld }, STORE_IDENTITY_MAX_DRIFT_MS);
    ok(v.ok, "a quiet deployment — both sides equally OLD — still passes: this is an EQUALITY check, not a recency check");
  }

  {
    const v1 = evaluateStoreIdentity({ localNewestTs: null, remoteNewestTs: T0 }, STORE_IDENTITY_MAX_DRIFT_MS);
    ok(!v1.ok, "an empty LOCAL store is refused, not treated as vacuously fine");
    const v2 = evaluateStoreIdentity({ localNewestTs: T0, remoteNewestTs: null }, STORE_IDENTITY_MAX_DRIFT_MS);
    ok(!v2.ok, "an empty REMOTE report is refused, not treated as vacuously fine");
    const v3 = evaluateStoreIdentity({ localNewestTs: null, remoteNewestTs: null }, STORE_IDENTITY_MAX_DRIFT_MS);
    ok(!v3.ok, "both sides empty is refused, not treated as trivially equal");
  }

  {
    const v = evaluateStoreIdentity({ localNewestTs: "not-a-date", remoteNewestTs: T0 }, STORE_IDENTITY_MAX_DRIFT_MS);
    ok(!v.ok, "an unparseable local timestamp is refused");
  }
}

{
  {
    let threw = false;
    try {
      resolveStoreIdentityGuardConfig("default", {});
    } catch (err) {
      threw = true;
      ok(String(err instanceof Error ? err.message : err).includes("E2E_TARGET_URL"), "no-target refusal names the env var to set");
    }
    ok(threw, "🔴 THE FIX: no E2E_TARGET_URL / OE_DEPLOY_ALIAS FAILS CLOSED (throws), never silently proceeds unverified");
  }

  {
    let threw = false;
    try {
      resolveStoreIdentityGuardConfig("default", { E2E_TARGET_URL: "https://example.vercel.app" });
    } catch (err) {
      threw = true;
      ok(String(err instanceof Error ? err.message : err).includes("E2E_CONTROL_READ_TOKEN"), "no-token refusal names the env var to set");
    }
    ok(threw, "🔴 THE FIX: no E2E_CONTROL_READ_TOKEN FAILS CLOSED, even with a target set");
  }

  {
    const cfg = resolveStoreIdentityGuardConfig("myorg", { OE_DEPLOY_ALIAS: "my-agent.vercel.app", E2E_CONTROL_READ_TOKEN: "tok" });
    eq(cfg.targetUrl, "https://my-agent.vercel.app", "OE_DEPLOY_ALIAS derives an https URL when E2E_TARGET_URL is absent");
    eq(cfg.readToken, "tok", "…token carried through");
    eq(cfg.org, "myorg", "…org carried through");
  }
  {
    const cfg = resolveStoreIdentityGuardConfig("default", {
      E2E_TARGET_URL: "https://explicit.example.com",
      OE_DEPLOY_ALIAS: "ignored.example.com",
      E2E_CONTROL_READ_TOKEN: "tok",
    });
    eq(cfg.targetUrl, "https://explicit.example.com", "E2E_TARGET_URL wins over OE_DEPLOY_ALIAS when both are set");
  }
}

{
  const pg = await openTestPg();
  const client: PgClient = pg.client;
  await initOperationalSchema(client);
  const store = makeOperationalPostgresStore(client);
  const ORG = "default";

  await store.appendAudit({ ts: T0, org: ORG, platform: "control", workspace: "control", action: "control.service_call" });

  const fakeFetchMatching: FetchAuditFn = async () => [{ ts: T0, org: ORG, platform: "control", workspace: "control", action: "control.service_call" }];
  const fakeFetchStale: FetchAuditFn = async () => [
    { ts: "2020-01-01T00:00:00.000Z", org: ORG, platform: "control", workspace: "control", action: "control.service_call" },
  ];
  const fakeFetchEmpty: FetchAuditFn = async () => [];
  const fakeFetchUnreachable: FetchAuditFn = async () => {
    throw new Error("fetch failed: getaddrinfo ENOTFOUND");
  };

  {
    const v = await assertStoreIdentity(store, { targetUrl: "https://deployment.example.com", readToken: "tok", org: ORG }, fakeFetchMatching);
    ok(v.ok, "a matching store PASSES — assertStoreIdentity resolves rather than throwing");
  }

  await throws(
    "🔴 THE FIX: a healthy-but-wrong store (a live run's exact shape)",
    () => assertStoreIdentity(store, { targetUrl: "https://deployment.example.com", readToken: "tok", org: ORG }, fakeFetchStale),
    "STORE-IDENTITY GUARD",
  );

  await throws(
    "control plane unreachable",
    () => assertStoreIdentity(store, { targetUrl: "https://deployment.example.com", readToken: "tok", org: ORG }, fakeFetchUnreachable),
    "could not reach the deployment's control plane",
  );

  await throws(
    "deployment reports an empty audit view",
    () => assertStoreIdentity(store, { targetUrl: "https://deployment.example.com", readToken: "tok", org: ORG }, fakeFetchEmpty),
    "STORE-IDENTITY GUARD",
  );

  await throws(
    "an org this store has no rows under",
    () => assertStoreIdentity(store, { targetUrl: "https://deployment.example.com", readToken: "tok", org: "other-org" }, fakeFetchMatching),
    "STORE-IDENTITY GUARD",
  );
}

assert.ok(passed > 0, "at least one assertion ran");
console.log(
  `✓ store-identity-guard: ${passed} assertions passed (matching store passes, a live run-shaped divergence refused, ` +
    "quiet-but-equal deployment passes, missing target/token fails closed, unreachable control plane fails closed)",
);
await closeAllTestPg();
