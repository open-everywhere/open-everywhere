import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-warm-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");

const { warmCredential, DEFAULT_REFRESH_MARGIN_MS } = await import("../agent/credentials/warm.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { deploymentOrg } = await import("../agent/identity/binding.js");
const { getSecretVia, getSecretWithLifetimeVia, registerBroker, resetBrokers } = await import("../agent/access/credentials.js");

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }
  passed++;
}

const HOUR_MS = 60 * 60 * 1000;

try {
  {
    let mints = 0;
    const cred = warmCredential({
      name: "test.memo",
      platform: "test",
      auditAction: "test.token_mint_failed",
      refresh: "re-mint",
      fallbackTtlSeconds: 3600,
      mint: async () => {
        mints++;
        return { value: `tok-${mints}`, expiresAtMs: Date.now() + HOUR_MS };
      },
    });
    ok((await cred.get()) === "tok-1", "first get mints");
    ok((await cred.get()) === "tok-1" && mints === 1, "a fresh credential is served from the hold (no second mint)");
    ok(cred.peek()?.expiresAtMs !== undefined, "peek exposes the held deadline");
    cred.reset();
    ok(cred.peek() === undefined, "reset drops the hold");
    ok((await cred.get()) === "tok-2", "after reset the next get mints again");
  }

  {
    let mints = 0;
    const cred = warmCredential({
      name: "test.margin",
      platform: "test",
      auditAction: "test.token_mint_failed",
      refresh: "re-mint",
      fallbackTtlSeconds: 3600,
      mint: async () => {
        mints++;
        return { value: `tok-${mints}`, expiresAtMs: Date.now() + DEFAULT_REFRESH_MARGIN_MS - 1000 };
      },
    });
    await cred.get();
    await cred.get();
    ok(mints === 2, "a credential inside the refresh margin is re-minted, not served (never expires mid-flight)");
  }

  {
    let mints = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const cred = warmCredential({
      name: "test.single-flight",
      platform: "test",
      auditAction: "test.token_mint_failed",
      refresh: "re-mint",
      fallbackTtlSeconds: 3600,
      mint: async () => {
        mints++;
        await gate;
        return { value: "shared", expiresAtMs: Date.now() + HOUR_MS };
      },
    });
    const all = [cred.get(), cred.get(), cred.get()];
    await new Promise((r) => setTimeout(r, 10));
    release();
    const got = await Promise.all(all);
    ok(got.every((t) => t === "shared"), "single-flight: every concurrent caller gets the same credential");
    ok(mints === 1, "single-flight: exactly ONE mint for three concurrent gets (no stampede)");
  }

  {
    const seen: string[] = [];
    const cred = warmCredential<{ id: string }>({
      name: "test.keyed",
      platform: "test",
      auditAction: "test.token_mint_failed",
      refresh: "re-mint",
      fallbackTtlSeconds: 3600,
      key: (ctx) => ctx.id,
      mint: async (ctx) => {
        seen.push(ctx.id);
        return { value: `tok-${ctx.id}`, expiresAtMs: Date.now() + HOUR_MS };
      },
    });
    ok((await cred.get({ id: "a" })) === "tok-a", "keyed: key a mints its own credential");
    ok((await cred.get({ id: "b" })) === "tok-b", "keyed: key b mints a SEPARATE credential (never served a's)");
    await cred.get({ id: "a" });
    ok(seen.length === 2, "keyed: each key has its own hold (a's second get is served from the hold)");
    ok(cred.peek({ id: "a" })?.value === "tok-a" && cred.peek({ id: "b" })?.value === "tok-b", "keyed: peek is per key");
  }

  {
    const org = deploymentOrg();
    const before = (await readAudit({ org, platform: "test", action: "test.token_mint_failed" })).length;
    let mode: "ok" | "boom" = "ok";
    let mints = 0;
    const cred = warmCredential({
      name: "test.loud",
      platform: "test",
      auditAction: "test.token_mint_failed",
      refresh: "re-mint",
      refreshMarginMs: 0,
      fallbackTtlSeconds: 3600,
      mint: async () => {
        mints++;
        if (mode === "boom") throw new Error("simulated mint failure (no credential material here)");
        return { value: "short-lived", expiresAtMs: Date.now() + 20 };
      },
    });
    ok((await cred.get()) === "short-lived", "loud: the first mint succeeds and is held");
    await new Promise((r) => setTimeout(r, 40));
    mode = "boom";
    let threw = false;
    let message = "";
    try {
      await cred.get();
    } catch (err) {
      threw = true;
      message = String(err);
    }
    ok(threw, "loud: a failing mint REJECTS — never a silent fallback to the expired held credential");
    ok(message.includes("simulated mint failure"), "loud: the mint's own diagnosable message surfaces to the caller");
    ok(mints === 2, "loud: the expired credential really was re-minted (not served)");

    const after = await readAudit({ org, platform: "test", action: "test.token_mint_failed" });
    ok(after.length > before, "loud: a mint failure appends a durable audit row under the DECLARED action");
    const last = after[0]!;
    ok(last.detail?.credential === "test.loud", "loud: the audit row names which credential failed");
    ok(typeof last.detail?.error === "string" && (last.detail!.error as string).length > 0, "loud: the audit row carries a non-empty error detail");

    mode = "ok";
    ok((await cred.get()) === "short-lived", "loud: after a failed mint the NEXT get retries and recovers (no wedge)");
  }

  {
    const org = deploymentOrg();
    const before = (await readAudit({ org, platform: "test", action: "test.sf_fail" })).length;
    let mints = 0;
    const cred = warmCredential({
      name: "test.sf-fail",
      platform: "test",
      auditAction: "test.sf_fail",
      refresh: "re-mint",
      fallbackTtlSeconds: 3600,
      mint: async () => {
        mints++;
        await new Promise((r) => setTimeout(r, 10));
        throw new Error("always fails");
      },
    });
    const results = await Promise.allSettled([cred.get(), cred.get(), cred.get()]);
    ok(results.every((r) => r.status === "rejected"), "single-flight failure: every concurrent caller rejects");
    ok(mints === 1, "single-flight failure: exactly ONE mint attempt for three concurrent gets");
    const after = await readAudit({ org, platform: "test", action: "test.sf_fail" });
    ok(after.length === before + 1, "single-flight failure: ONE audit row for the shared attempt, not one per caller");
  }

  {
    const org = deploymentOrg();
    const before = (await readAudit({ org, platform: "test", action: "test.empty" })).length;
    const cred = warmCredential({
      name: "test.empty",
      platform: "test",
      auditAction: "test.empty",
      refresh: "re-mint",
      fallbackTtlSeconds: 3600,
      mint: async () => ({ value: "", expiresAtMs: Date.now() + HOUR_MS }),
    });
    let threw = false;
    try {
      await cred.get();
    } catch {
      threw = true;
    }
    ok(threw, "an empty mint value THROWS (a placeholder credential is a failure, not a credential)");
    ok((await readAudit({ org, platform: "test", action: "test.empty" })).length > before, "…and is audited as loudly as any other mint failure");
    ok(cred.peek() === undefined, "…and nothing is held");
  }

  {
    const cred = warmCredential({
      name: "test.fallback-ttl",
      platform: "test",
      auditAction: "test.token_mint_failed",
      refresh: "re-mint",
      fallbackTtlSeconds: 7200,
      mint: async () => ({ value: "no-stated-expiry" }),
    });
    const t0 = Date.now();
    await cred.get();
    const held = cred.peek()!;
    ok(held.expiresAtMs !== undefined, "re-mint: a response with no stated expiry is still given a deadline");
    ok(held.expiresAtMs! - t0 > 7100_000 && held.expiresAtMs! - t0 < 7300_000, "re-mint: the deadline is the declared fallback TTL (never 'forever')");
  }

  {
    let mints = 0;
    const cred = warmCredential({
      name: "test.manual",
      platform: "test",
      auditAction: "test.token_mint_failed",
      refresh: "manual-rotation",
      mint: async () => {
        mints++;
        return { value: "static-ish" };
      },
    });
    await cred.get();
    await cred.get();
    ok(mints === 1, "manual-rotation: a credential with no deadline is held, not re-minted");
    ok(cred.peek()?.expiresAtMs === undefined, "manual-rotation: the hold carries no invented deadline");
  }

  {
    let threw = false;
    let msg = "";
    try {
      warmCredential({ name: "test.refresh-token", platform: "test", auditAction: "x", refresh: "refresh-token", mint: async () => ({ value: "v" }) });
    } catch (err) {
      threw = true;
      msg = String(err);
    }
    ok(threw, 'the "refresh-token" posture is REFUSED — a process-local memo cannot do cross-process rotation');
    ok(msg.includes("kv-vault"), "…and the refusal names where that posture does belong");

    threw = false;
    try {
      warmCredential({ name: "test.no-ttl", platform: "test", auditAction: "x", refresh: "re-mint", mint: async () => ({ value: "v" }) });
    } catch {
      threw = true;
    }
    ok(threw, 'a "re-mint" credential with no fallbackTtlSeconds is REFUSED (it could otherwise be held forever)');

    threw = false;
    try {
      warmCredential({ name: "test.bad-margin", platform: "test", auditAction: "x", refresh: "re-mint", fallbackTtlSeconds: 60, refreshMarginMs: -1, mint: async () => ({ value: "v" }) });
    } catch {
      threw = true;
    }
    ok(threw, "a negative refresh margin is REFUSED");
  }

  {
    process.env.OE_WARM_TEST_SECRET = "env-value";
    const stored = await getSecretWithLifetimeVia("env", "OE_WARM_TEST_SECRET");
    ok(stored.value === "env-value", "getSecretWithLifetimeVia resolves through the named broker");
    ok(stored.expiresAtMs === undefined, "a STORED secret truthfully reports no stated expiry (never a guessed deadline)");
    delete process.env.OE_WARM_TEST_SECRET;

    const deadline = Date.now() + HOUR_MS;
    registerBroker("test-minting", {
      getSecret: async () => "should-not-be-used-when-lifetime-is-implemented",
      getSecretWithLifetime: async (ref) => ({ value: `minted:${ref}`, expiresAtMs: deadline }),
    });
    const minted = await getSecretWithLifetimeVia("test-minting", "some/ref");
    ok(minted.value === "minted:some/ref" && minted.expiresAtMs === deadline, "a minting broker reports the deadline it just issued");
    ok((await getSecretVia("test-minting", "some/ref")) === "minted:some/ref", "getSecretVia reads through the SAME path (the two methods cannot disagree)");

    let failedClosed = false;
    try {
      await getSecretWithLifetimeVia("nope-not-registered", "r");
    } catch {
      failedClosed = true;
    }
    ok(failedClosed, "getSecretWithLifetimeVia fails closed on an unregistered broker (same rule as getSecretVia)");
    failedClosed = false;
    try {
      await getSecretWithLifetimeVia(undefined, "r");
    } catch {
      failedClosed = true;
    }
    ok(failedClosed, "getSecretWithLifetimeVia fails closed on an unstamped credential");
    resetBrokers();
  }

  console.log(`\n✓ warm-credential: ${passed} assertions passed`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
