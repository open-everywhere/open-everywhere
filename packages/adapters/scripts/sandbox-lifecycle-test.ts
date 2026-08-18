import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { overrideSettingsForTest } from "@open-everywhere/core/agent/adapter-api.js";
import lifecycleHook, {
  shouldStop,
  stopAfterTurnEnabled,
  stopSessionSandboxes,
  restoreParentSandboxTag,
  recordSandboxUsage,
  resetStopOwnershipLogForTest,
} from "../agent/sandbox/vercel-lifecycle.js";
import {
  createDockerStopper,
  createVercelList,
  dockerStatusToSandboxStatus,
  justBashStopper,
  resolveSandboxStopper,
  setSandboxStopperForTest,
  vercelStopper,
  DOCKER_SESSION_LABEL,
  type SandboxStopper,
  type VercelListSdk,
} from "../agent/sandbox/backend-stop.js";
import { recordCreatedSandbox, clearRecordedSandboxesForTest } from "../agent/sandbox/created-sandbox-registry.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

function testStopper(parts: Partial<SandboxStopper>): SandboxStopper {
  return {
    backend: "test",
    metered: true,
    ownership: "test stopper",
    list: async () => [],
    stop: async () => {},
    retag: async () => true,
    ...parts,
  };
}

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
  const deps = testStopper({
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
  });
  const stopped = await stopSessionSandboxes("sess-1", deps);
  ok(stops.length === 1 && stops[0] === "sbx-main", "only the running sandbox is stopped");
  ok(stopped.length === 1 && stopped[0].name === "sbx-main", "stopped names are reported");
}

{
  const stops: string[] = [];
  const deps = testStopper({
    list: async () => [
      { name: "sbx-a", status: "running", createdAt: 1_000 },
      { name: "sbx-b", status: "running", createdAt: 1_000 },
    ],
    stop: async (name) => {
      if (name === "sbx-a") throw new Error("transient API error");
      stops.push(name);
    },
  });
  const stopped = await stopSessionSandboxes("sess-2", deps);
  ok(stops.length === 1 && stops[0] === "sbx-b", "a failed stop doesn't block the next sandbox");
  ok(stopped.length === 1 && stopped[0].name === "sbx-b", "only the successful stop is reported");
}

{
  const deps = testStopper({
    list: async () => [],
    stop: async () => {
      throw new Error("must not be called");
    },
  });
  const stopped = await stopSessionSandboxes("sess-3", deps);
  ok(stopped.length === 0, "no tagged sandboxes → nothing stopped, nothing thrown");
}

{
  const deps = testStopper({
    list: async () => [{ name: "sbx-timed", status: "running", createdAt: 10_000 }],
  });
  const stopped = await stopSessionSandboxes("sess-4", deps, () => 10_000 + 45_000);
  ok(stopped.length === 1 && stopped[0].sandboxSeconds === 45, "sandboxSeconds = (now - createdAt) via the injected clock");
}

{
  const deps = testStopper({
    list: async () => [{ name: "sbx-skew", status: "running", createdAt: 10_000 }],
  });
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

{
  {
    clearRecordedSandboxesForTest();
    const getByNameCalls: string[] = [];
    const sdk: VercelListSdk = {
      listByTag: async () => [],
      getByName: async (name) => {
        getByNameCalls.push(name);
        return { name, status: "running", createdAt: 5_000 };
      },
    };
    recordCreatedSandbox("sess-722-fresh", "eve-sbx-ses-vercel-abc-sess-722-fresh");
    const listed = await createVercelList(sdk)("sess-722-fresh");
    ok(
      listed.length === 1 && listed[0].name === "eve-sbx-ses-vercel-abc-sess-722-fresh" && listed[0].status === "running",
      "🔴 OPE-722: a stale (empty) Sandbox.list is augmented by a direct Sandbox.get for the id THIS process recorded",
    );
    ok(getByNameCalls.length === 1, "…via exactly one direct-by-name lookup, not a retry loop against the tag index");

    const unrecorded = await createVercelList(sdk)("sess-722-never-recorded");
    ok(unrecorded.length === 0, "negative control: a session nothing recorded a name for gets NO augmentation — list() stays exactly what the tag index reported");
  }

  {
    clearRecordedSandboxesForTest();
    let getByNameCalls = 0;
    const sdk: VercelListSdk = {
      listByTag: async () => [{ name: "sbx-already-listed", status: "running", createdAt: 1_000 }],
      getByName: async (name) => {
        getByNameCalls++;
        return { name, status: "running", createdAt: 1_000 };
      },
    };
    recordCreatedSandbox("sess-722-already-listed", "sbx-already-listed");
    const listed = await createVercelList(sdk)("sess-722-already-listed");
    ok(listed.length === 1, "when the recorded name is ALREADY in the tag-list result, it is not duplicated");
    ok(getByNameCalls === 0, "…and the direct lookup is skipped entirely — the tag index was already fresh, no extra vendor call is spent");
  }

  {
    clearRecordedSandboxesForTest();
    const sdk: VercelListSdk = {
      listByTag: async () => [],
      getByName: async () => undefined,
    };
    recordCreatedSandbox("sess-722-vanished", "sbx-vanished");
    const listed = await createVercelList(sdk)("sess-722-vanished");
    ok(listed.length === 0, "a recorded name the vendor no longer has does not produce a phantom listing");
  }

  {
    clearRecordedSandboxesForTest();
    let getByNameCalls = 0;
    const sdk: VercelListSdk = {
      listByTag: async () => [],
      getByName: async (name) => {
        getByNameCalls++;
        return { name, status: "running", createdAt: 1_000 };
      },
    };
    recordCreatedSandbox("sess-722-other", "sbx-other-session");
    const listed = await createVercelList(sdk)("sess-722-unrelated");
    ok(listed.length === 0 && getByNameCalls === 0, "🔴 a name recorded for a DIFFERENT session id is never consulted for this one — the registry is keyed per session, not global");
  }

  {
    clearRecordedSandboxesForTest();
    const stops: string[] = [];
    const sdk: VercelListSdk = {
      listByTag: async () => [],
      getByName: async (name) => ({ name, status: "running", createdAt: 2_000 }),
    };
    const stopper: SandboxStopper = { ...vercelStopper, list: createVercelList(sdk), stop: async (name) => { stops.push(name); } };
    recordCreatedSandbox("sess-722-e2e", "sbx-e2e");
    const stopped = await stopSessionSandboxes("sess-722-e2e", stopper, () => 2_000 + 30_000);
    ok(stopped.length === 1 && stopped[0].name === "sbx-e2e", "🔴 OPE-722: stopSessionSandboxes stops a sandbox a stale tag list missed, purely via the id-record");
    ok(stops.includes("sbx-e2e"), "…the stop() call is actually issued, not merely reported");
    ok(stopped[0].sandboxSeconds === 30, "…and the runtime window is still honestly computed from the merged listing's createdAt");
  }
}

{
  const platform = process.env.OE_PLATFORM;
  const backend = process.env.OE_SANDBOX_BACKEND;

  process.env.OE_PLATFORM = "vercel";
  ok(resolveSandboxStopper().backend === "vercel", "on Vercel the Vercel stopper owns the stop");
  ok(resolveSandboxStopper().metered === true, "…and Vercel is the metered backend, so its stops are priced");

  process.env.OE_PLATFORM = "self-host";
  delete process.env.OE_SANDBOX_BACKEND;
  ok(resolveSandboxStopper().backend === "docker", "🔴 OPE-450: off Vercel the DEFAULT self-host backend gets a real stop (was: nothing, silently)");
  ok(resolveSandboxStopper().metered === false, "…and docker is NOT metered per second, so no Vercel-rate spend row is invented for it");

  process.env.OE_SANDBOX_BACKEND = "justbash";
  ok(resolveSandboxStopper().backend === "just-bash", "the just-bash backend selects its own (inert) stopper");
  ok((await resolveSandboxStopper().list("sess-x")).length === 0, "…whose peek is empty — there is no VM or container in this app process to find");

  for (const s of [vercelStopper, createDockerStopper(), justBashStopper]) {
    ok(s.ownership.length > 0 && s.ownership.includes(s.backend === "just-bash" ? "NONE" : s.backend), `the ${s.backend} stopper's ownership line names who stops the sandbox`);
  }

  if (platform === undefined) delete process.env.OE_PLATFORM;
  else process.env.OE_PLATFORM = platform;
  if (backend === undefined) delete process.env.OE_SANDBOX_BACKEND;
  else process.env.OE_SANDBOX_BACKEND = backend;
}

{
  const calls: string[][] = [];
  const stopper = createDockerStopper(async (args) => {
    calls.push([...args]);
    if (args[0] === "ps") return "oe-live\noe-dead\n";
    if (args[0] === "inspect") return "/oe-live\trunning\t2026-08-13T00:00:00.000Z\n/oe-dead\texited\t2026-08-13T00:00:00.000Z\n";
    return "";
  });

  const listed = await stopper.list("sess-docker");
  ok(
    calls[0]?.includes(`label=${DOCKER_SESSION_LABEL}=sess-docker`),
    "the docker peek filters on eve's own per-session container label — a `docker ps`, which provisions nothing",
  );
  ok(listed.length === 2 && listed[0].status === "running" && listed[1].status === "exited", "…and reports each container's state, normalised onto the shared vocabulary");
  ok(listed[0].createdAt === Date.parse("2026-08-13T00:00:00.000Z"), "…with StartedAt as the honest window start");

  const stopped = await stopSessionSandboxes("sess-docker", stopper, () => Date.parse("2026-08-13T00:01:00.000Z"));
  ok(stopped.length === 1 && stopped[0].name === "oe-live", "🔴 OPE-450: a docker deployment stops its RUNNING session container and leaves the exited one alone");
  ok(stopped[0].sandboxSeconds === 60, "…and reports its runtime window");
  const stopCall = calls.find((c) => c[0] === "stop");
  ok(stopCall !== undefined && stopCall.join(" ") === "stop -t 0 oe-live", "…through `docker stop -t 0` — never `rm`, so eve restarts the same container with its filesystem intact");

  ok(dockerStatusToSandboxStatus("created") === "pending" && dockerStatusToSandboxStatus("restarting") === "pending", "docker's created/restarting map onto `pending`");
  ok(dockerStatusToSandboxStatus("exited") === "exited" && dockerStatusToSandboxStatus("paused") === "paused", "…and every other docker state passes through untouched, so it is left alone");
  ok((await stopper.retag("oe-live", "sess-parent")) === false, "docker answers FALSE to a re-tag: eve labels a container only at creation and never re-labels on attach, so there is nothing to hand back");
}

{
  const stops: string[] = [];
  const stopper = createDockerStopper(async (args) => {
    if (args[0] === "ps") return "oe-a\noe-gone\n";
    if (args[0] === "inspect") throw new Error("Error: No such object: oe-gone");
    if (args[0] === "stop") {
      if (args[3] === "oe-gone") throw new Error("Error response from daemon: No such container");
      stops.push(String(args[3]));
    }
    return "";
  });
  const stopped = await stopSessionSandboxes("sess-vanish", stopper);
  ok(stops.length === 1 && stops[0] === "oe-a", "a failed inspect falls back to stopping every listed container, so the survivor is still stopped");
  ok(stopped.length === 1 && stopped[0].name === "oe-a", "…and the vanished one's failed stop is reported as not stopped, not as a thrown sweep");
}

const childCtx = {
  agent: { name: "oe" },
  channel: { kind: "subagent", continuationToken: "subagent:sess-parent:call_1" },
  session: {
    id: "sess-child",
    parent: { sessionId: "sess-parent", callId: "call_1", rootSessionId: "sess-parent" },
    auth: { current: { attributes: { team_id: "T1", channel_id: "C_SBX" } } },
  },
};

const parentCtx = {
  agent: { name: "oe" },
  channel: { kind: "slack" },
  session: { id: "sess-parent", auth: { current: { attributes: { team_id: "T1", channel_id: "C_SBX" } } } },
};

{
  overrideSettingsForTest({ sandbox: { stopAfterTurn: true } });
  const stops: string[] = [];
  const retags: Array<{ name: string; sessionId: string }> = [];
  const stopper = testStopper({
    backend: "vercel",
    metered: false,
    ownership: "stop owner = vercel — test",
    list: async () => [{ name: "sbx-shared", status: "running", createdAt: 1_000 }],
    stop: async (name) => {
      stops.push(name);
    },
    retag: async (name, sessionId) => {
      retags.push({ name, sessionId });
      return true;
    },
  });
  setSandboxStopperForTest(stopper);

  const turnCompleted = (lifecycleHook.events ?? {})["turn.completed"] as (e: unknown, c: unknown) => Promise<void>;

  await turnCompleted({}, childCtx);
  ok(stops.length === 0, "🔴 OPE-447: a subagent child issues NO stop — the parent owns the shared VM and is still mid-turn");
  ok(
    retags.length === 1 && retags[0].name === "sbx-shared" && retags[0].sessionId === "sess-parent",
    "🔴 OPE-447: …and the shared sandbox is re-tagged back to the PARENT's session id, so the parent's own sweep works unconditionally",
  );

  stops.length = 0;
  retags.length = 0;
  await turnCompleted({}, parentCtx);
  ok(stops.includes("sbx-shared") === true, "negative control: an ordinary (non-child) turn DOES stop its own sandbox — the stop is issued, not merely error-free");
  ok(retags.length === 0, "…and never re-tags anything: only a child hands ownership back");

  setSandboxStopperForTest(undefined);
}

{
  const retags: string[] = [];
  const stopper = testStopper({
    list: async () => [{ name: "sbx-shared", status: "running", createdAt: 1_000 }],
    retag: async (name) => {
      retags.push(name);
      return true;
    },
  });
  const noParent = { channel: { kind: "subagent" }, session: { id: "sess-child" } };
  const restored = await restoreParentSandboxTag(noParent as never, stopper);
  ok(restored.length === 0 && retags.length === 0, "with no typed parent linkage there is nothing to re-tag TO, so no re-tag is attempted (the skipped stop is still correct)");

  const inert = testStopper({
    list: async () => [{ name: "oe-live", status: "running", createdAt: 1_000 }],
    retag: async () => false,
  });
  const none = await restoreParentSandboxTag(childCtx as never, inert);
  ok(none.length === 0, "a backend that never re-tags on attach reports nothing restored — a correct outcome, not an error");
}

{
  resetStopOwnershipLogForTest();
  const lines: string[] = [];
  const realLog = console.log;
  console.log = (msg?: unknown) => {
    lines.push(String(msg));
  };
  try {
    setSandboxStopperForTest(testStopper({ metered: false, ownership: "stop owner = probe-backend", list: async () => [] }));
    const turnCompleted = (lifecycleHook.events ?? {})["turn.completed"] as (e: unknown, c: unknown) => Promise<void>;
    await turnCompleted({}, parentCtx);
    await turnCompleted({}, parentCtx);
  } finally {
    console.log = realLog;
    setSandboxStopperForTest(undefined);
  }
  const owner = lines.filter((l) => l.includes("stop owner = probe-backend"));
  ok(owner.length === 1, `🔴 OPE-450: the deployment SAYS which backend owns the stop, once per process (got ${owner.length} lines)`);
}

{
  const dir = join(tmpdir(), `oe-sandbox-lifecycle-metered-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
  const { resolvePartition, domainKeyOf, spendTotals, periodOf } = await import("@open-everywhere/core/agent/adapter-api.js");
  const turnCompleted = (lifecycleHook.events ?? {})["turn.completed"] as (e: unknown, c: unknown) => Promise<void>;
  const listing = async () => [{ name: "sbx-metered", status: "running", createdAt: Date.now() - 3_600_000 }];

  setSandboxStopperForTest(testStopper({ backend: "docker", metered: false, list: listing }));
  await turnCompleted({}, parentCtx);
  const p = resolvePartition(parentCtx as never);
  const period = periodOf(new Date().toISOString());
  const unmetered = await spendTotals(p.org, { surfaceKey: domainKeyOf(p), period });
  ok(unmetered.calls === 0 && unmetered.usdMicros === 0, "an UNMETERED backend's stop writes NO spend row — a self-hosted container has no per-second bill to book");

  setSandboxStopperForTest(testStopper({ backend: "vercel", metered: true, list: listing }));
  await turnCompleted({}, parentCtx);
  const metered = await spendTotals(p.org, { surfaceKey: domainKeyOf(p), period });
  ok(metered.calls === 1 && metered.usdMicros > 0, `the METERED backend's stop DOES book its runtime (got ${metered.calls} row(s), ${metered.usdMicros} micros)`);

  setSandboxStopperForTest(undefined);
  rmSync(dir, { recursive: true, force: true });
  delete process.env.OE_SQLITE_PATH;
}

console.log(`\n✓ sandbox-lifecycle: ${n} assertions passed (hook shape, stop decisions, fail-soft, enable flag, runtime-seconds, spend-ledger $ record + principal/routine attribution + delta billing, write-ordering safety, duplicate-name dedupe, backend selection + docker stop + the subagent-child guard, OPE-722 id-record augmentation of Sandbox.list)\n`);
