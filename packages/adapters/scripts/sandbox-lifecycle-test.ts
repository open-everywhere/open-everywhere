import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { overrideSettingsForTest } from "@open-everywhere/core/agent/adapter-api.js";
import lifecycleHook, {
  shouldStop,
  stopAfterTurnEnabled,
  stopSessionSandboxes,
  recordSandboxUsage,
  type SandboxLifecycleDeps,
} from "../agent/sandbox/vercel-lifecycle.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

{
  const events = lifecycleHook.events ?? {};
  for (const key of ["turn.completed", "turn.failed", "session.completed", "session.failed"]) {
    ok(typeof (events as Record<string, unknown>)[key] === "function", `hook subscribes to ${key}`);
  }
}

{
  ok(shouldStop("running"), "running → stop");
  ok(shouldStop("pending"), "pending → stop");
  for (const s of ["stopped", "stopping", "snapshotting", "failed", "aborted"]) {
    ok(!shouldStop(s), `${s} → leave alone`);
  }
}

{
  overrideSettingsForTest({ sandbox: { stopAfterTurn: true } });
  ok(stopAfterTurnEnabled(), "enabled by default");
  overrideSettingsForTest({ sandbox: { stopAfterTurn: false } });
  ok(!stopAfterTurnEnabled(), "OE_SANDBOX_STOP_AFTER_TURN=0 disables");
  overrideSettingsForTest({ sandbox: { stopAfterTurn: true } });
  ok(stopAfterTurnEnabled(), "OE_SANDBOX_STOP_AFTER_TURN=1 keeps it on");
  overrideSettingsForTest({ sandbox: { stopAfterTurn: true } });
}

{
  const stops: string[] = [];
  const deps: SandboxLifecycleDeps = {
    list: async (sessionId) => {
      ok(sessionId === "sess-1", "list is queried with the session id");
      return [
        { name: "sbx-main", status: "running", createdAt: 1_000 },
        { name: "sbx-old", status: "stopped", createdAt: 1_000 },
        { name: "sbx-mid", status: "snapshotting", createdAt: 1_000 },
      ];
    },
    stop: async (name) => {
      stops.push(name);
    },
  };
  const stopped = await stopSessionSandboxes("sess-1", deps);
  ok(stops.length === 1 && stops[0] === "sbx-main", "only the running sandbox is stopped");
  ok(stopped.length === 1 && stopped[0].name === "sbx-main", "stopped names are reported");
}

{
  const stops: string[] = [];
  const deps: SandboxLifecycleDeps = {
    list: async () => [
      { name: "sbx-a", status: "running", createdAt: 1_000 },
      { name: "sbx-b", status: "running", createdAt: 1_000 },
    ],
    stop: async (name) => {
      if (name === "sbx-a") throw new Error("transient API error");
      stops.push(name);
    },
  };
  const stopped = await stopSessionSandboxes("sess-2", deps);
  ok(stops.length === 1 && stops[0] === "sbx-b", "a failed stop doesn't block the next sandbox");
  ok(stopped.length === 1 && stopped[0].name === "sbx-b", "only the successful stop is reported");
}

{
  const deps: SandboxLifecycleDeps = {
    list: async () => [],
    stop: async () => {
      throw new Error("must not be called");
    },
  };
  const stopped = await stopSessionSandboxes("sess-3", deps);
  ok(stopped.length === 0, "no tagged sandboxes → nothing stopped, nothing thrown");
}

{
  const deps: SandboxLifecycleDeps = {
    list: async () => [{ name: "sbx-timed", status: "running", createdAt: 10_000 }],
    stop: async () => {},
  };
  const stopped = await stopSessionSandboxes("sess-4", deps, () => 10_000 + 45_000);
  ok(stopped.length === 1 && stopped[0].sandboxSeconds === 45, "sandboxSeconds = (now - createdAt) via the injected clock");
}

{
  const deps: SandboxLifecycleDeps = {
    list: async () => [{ name: "sbx-skew", status: "running", createdAt: 10_000 }],
    stop: async () => {},
  };
  const stopped = await stopSessionSandboxes("sess-5", deps, () => 9_000);
  ok(stopped[0].sandboxSeconds === 0, "sandboxSeconds clamps at 0 rather than going negative");
}

{
  const dir = join(tmpdir(), `oe-sandbox-lifecycle-test-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
  const { resolvePartition, domainKeyOf, spendTotals, periodOf, estimateSandboxCostUsd } = await import(
    "@open-everywhere/core/agent/adapter-api.js"
  );

  const ctx = {
    channel: { kind: "slack" },
    session: { id: "sess-ledger", auth: { current: { attributes: { team_id: "T1", channel_id: "C_SBX" } } } },
  };
  await recordSandboxUsage(ctx as never, [{ name: "sbx-billed", sandboxSeconds: 3600 }]);

  const p = resolvePartition(ctx as never);
  const totals = await spendTotals(p.org, { surfaceKey: domainKeyOf(p), period: periodOf(new Date().toISOString()) });
  const expectedMicros = Math.round(estimateSandboxCostUsd(3600) * 1_000_000);
  ok(totals.usdMicros === expectedMicros && expectedMicros > 0, `the stop's ledger line carries exactly the platform-rate estimate in usd_micros (got ${totals.usdMicros}, want ${expectedMicros})`);
  ok(totals.inputTokens === 0 && totals.outputTokens === 0, "…with zero tokens — runtime is not model spend, and a token cap is unaffected");
  ok(totals.calls === 1, "…and one ledger write per stopped sandbox");

  const fireCtx = {
    channel: { kind: "slack" },
    session: {
      id: "sess-fire-ledger",
      auth: {
        current: {
          attributes: {
            team_id: "T1",
            channel_id: "C_SBX2",
            open_everywhere_routine_id: "r-sbx",
            open_everywhere_routine_surface: "slack/T1/C_SBX2",
            open_everywhere_routine_org: "default",
            oe_fire_principal: "U_CREATOR",
          },
        },
      },
    },
  };
  await recordSandboxUsage(fireCtx as never, [{ name: "sbx-fire", sandboxSeconds: 1800 }]);
  const p2 = resolvePartition(fireCtx as never);
  const attributed = await spendTotals(p2.org, {
    surfaceKey: domainKeyOf(p2),
    principalId: "U_CREATOR",
    period: periodOf(new Date().toISOString()),
  });
  ok(
    attributed.usdMicros === Math.round(estimateSandboxCostUsd(1800) * 1_000_000) && attributed.usdMicros > 0,
    `OPE-275: a fire's sandbox $ lands on its CREATOR's ledger rows — the perUser axis can now see delegated runtime (got ${attributed.usdMicros} micros under U_CREATOR)`,
  );
  const byRoutine = await spendTotals(p2.org, {
    surfaceKey: domainKeyOf(p2),
    routineId: "r-sbx",
    period: periodOf(new Date().toISOString()),
  });
  ok(byRoutine.usdMicros === attributed.usdMicros, "OPE-275: …and on the ROUTINE's own dimension, so a routine's reported cost includes its compute");

  rmSync(dir, { recursive: true, force: true });
  delete process.env.OE_SQLITE_PATH;
}

{
  const dir = join(tmpdir(), `oe-sandbox-lifecycle-delta-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
  const { resolvePartition, domainKeyOf, spendTotals, periodOf, estimateSandboxCostUsd } = await import(
    "@open-everywhere/core/agent/adapter-api.js"
  );

  const ctx = {
    channel: { kind: "slack" },
    session: { id: "sess-multi", auth: { current: { attributes: { team_id: "T1", channel_id: "C_MULTI" } } } },
  };
  for (const cumulative of [100, 250, 400]) {
    await recordSandboxUsage(ctx as never, [{ name: "sbx-main", sandboxSeconds: cumulative }]);
  }

  const p = resolvePartition(ctx as never);
  const totals = await spendTotals(p.org, { surfaceKey: domainKeyOf(p), period: periodOf(new Date().toISOString()) });
  const billedOnce = Math.round(estimateSandboxCostUsd(400) * 1_000_000);
  const cumulativeBug = Math.round(estimateSandboxCostUsd(100 + 250 + 400) * 1_000_000);
  ok(
    Math.abs(totals.usdMicros - billedOnce) <= 3,
    `3-stop session bills the runtime ONCE (${totals.usdMicros} ≈ ${billedOnce} micros), not Σ cumulative (${cumulativeBug})`,
  );
  ok(totals.usdMicros < cumulativeBug, "…demonstrably below the pre-fix superlinear total (750s → 400s of billed runtime)");
  ok(totals.calls === 3, "…across three ledger writes (one delta per stop)");

  rmSync(dir, { recursive: true, force: true });
  delete process.env.OE_SQLITE_PATH;
}

{
  const dir = join(tmpdir(), `oe-sandbox-lifecycle-writeorder-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
  const {
    resolvePartition,
    domainKeyOf,
    spendTotals,
    periodOf,
    estimateSandboxCostUsd,
    getOperationalStore,
    registerOperationalStore,
    resetOperationalStore,
    usageForSession,
  } = await import("@open-everywhere/core/agent/adapter-api.js");
  type OperationalStore = ReturnType<typeof getOperationalStore>;

  const ctx = {
    channel: { kind: "slack" },
    session: { id: "sess-writeorder", auth: { current: { attributes: { team_id: "T1", channel_id: "C_ORDER" } } } },
  };
  const p = resolvePartition(ctx as never);

  const live = getOperationalStore();
  const broken = { ...live, id: live.id, recordSpend: async () => { throw new Error("ledger unavailable"); } } as OperationalStore;
  registerOperationalStore(broken);
  resetOperationalStore();
  ok(getOperationalStore() === broken, "write-ordering test: the broken store is actually in play");

  await recordSandboxUsage(ctx as never, [{ name: "sbx-order", sandboxSeconds: 300 }]);

  const totalsAfterFailure = await spendTotals(p.org, { surfaceKey: domainKeyOf(p), period: periodOf(new Date().toISOString()) });
  ok(totalsAfterFailure.usdMicros === 0 && totalsAfterFailure.calls === 0, "a failed ledger write records nothing in the ledger (as expected — it threw)");
  const eventsAfterFailure = (await usageForSession(p.org, "sess-writeorder")).filter((e) => e.kind === "sandbox");
  ok(eventsAfterFailure.length === 0, "🔴 the fix: a failed recordSpend must NOT advance the watermark — no usage_events row for the failed stop");

  registerOperationalStore(live);
  resetOperationalStore();
  ok(getOperationalStore() === live, "write-ordering test: the live store is restored");
  await recordSandboxUsage(ctx as never, [{ name: "sbx-order", sandboxSeconds: 500 }]);

  const totalsAfterRecovery = await spendTotals(p.org, { surfaceKey: domainKeyOf(p), period: periodOf(new Date().toISOString()) });
  const expectedRecoveredMicros = Math.round(estimateSandboxCostUsd(500) * 1_000_000);
  ok(
    totalsAfterRecovery.usdMicros === expectedRecoveredMicros && totalsAfterRecovery.calls === 1,
    `re-bill next stop: the recovered ledger holds the FULL 500s (the failed 300s were never lost) — got ${totalsAfterRecovery.usdMicros}, want ${expectedRecoveredMicros}`,
  );
  const eventsAfterRecovery = (await usageForSession(p.org, "sess-writeorder")).filter((e) => e.kind === "sandbox");
  ok(eventsAfterRecovery.length === 1 && eventsAfterRecovery[0].detail?.sandboxSeconds === 500, "…and the watermark row now carries the full 500s delta");

  rmSync(dir, { recursive: true, force: true });
  delete process.env.OE_SQLITE_PATH;
}

{
  const dir = join(tmpdir(), `oe-sandbox-lifecycle-dedupe-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
  const { resolvePartition, domainKeyOf, spendTotals, periodOf, estimateSandboxCostUsd } = await import(
    "@open-everywhere/core/agent/adapter-api.js"
  );

  const ctx = {
    channel: { kind: "slack" },
    session: { id: "sess-dedupe", auth: { current: { attributes: { team_id: "T1", channel_id: "C_DEDUPE" } } } },
  };
  await recordSandboxUsage(ctx as never, [
    { name: "sbx-dup", sandboxSeconds: 200 },
    { name: "sbx-dup", sandboxSeconds: 200 },
  ]);

  const p = resolvePartition(ctx as never);
  const totals = await spendTotals(p.org, { surfaceKey: domainKeyOf(p), period: periodOf(new Date().toISOString()) });
  const expectedMicros = Math.round(estimateSandboxCostUsd(200) * 1_000_000);
  ok(
    totals.usdMicros === expectedMicros && totals.calls === 1,
    `🔴 the fix: a duplicate sandbox name in one stop call bills ONCE, not twice (got ${totals.usdMicros} micros / ${totals.calls} calls, want ${expectedMicros} / 1)`,
  );

  rmSync(dir, { recursive: true, force: true });
  delete process.env.OE_SQLITE_PATH;
}

console.log(`\n✓ sandbox-lifecycle: ${n} assertions passed (hook shape, stop decisions, fail-soft, enable flag, runtime-seconds, spend-ledger $ record + principal/routine attribution + delta billing, write-ordering safety, duplicate-name dedupe)\n`);
