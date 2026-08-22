process.env.OE_SQLITE_PATH = ":memory:";
delete process.env.OE_MEMORY_SYNC_TIMING;

import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import memoryHook from "../agent/hooks/memory.js";
import { registerConfig } from "../agent/access/config.js";
import { registerProvider, type MemoryProvider } from "../agent/memory/provider.js";
import { siloTier, tierId, type MemoryFiles, type Tier } from "../agent/memory/store.js";
import type { Partition } from "../agent/memory/partition.js";
import { readAudit } from "../agent/audit/audit.js";
import {
  MEMORY_SYNC_TIMING_ACTION,
  OE_MEMORY_SYNC_TIMING_ENV,
  SILO_DETAIL_KEYS,
  SYNC_DETAIL_KEYS,
  byteSize,
  isTaintCleanDetail,
  memorySyncTimingEnabled,
  startMemorySyncTiming,
  toAuditDetail,
  type MemorySyncTiming,
} from "../agent/memory/sync-timing.js";
import {
  MEMORY_SYNC_TIMING_ACTION as DRIVER_ACTION,
  attributeBoot,
  decomposeSession,
  projectMemorySync,
  renderBootAttribution,
} from "./e2e/transcript-timings.js";
import type { AuditWireEntry } from "./e2e/audit-read.js";
import type { HookContext } from "eve/hooks";

import { registerSlackFixtureMapper } from "./_slack-test-stubs.js";
registerSlackFixtureMapper();

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

class FakeEveContext {
  private readonly store = new Map<string, unknown>();
  get<T>(key: { name: string }): T | undefined {
    return this.store.get(key.name) as T | undefined;
  }
  has(key: { name: string }): boolean {
    return this.store.has(key.name);
  }
  require<T>(key: { name: string }): T {
    if (!this.has(key)) throw new Error(`missing ${key.name}`);
    return this.get(key) as T;
  }
  set<T>(key: { name: string }, v: T | ((c: T | undefined) => T)): T {
    const next = typeof v === "function" ? (v as (c: T | undefined) => T)(this.get(key)) : v;
    this.store.set(key.name, next);
    return next;
  }
  ensure<T>(key: { name: string }, create: () => T): T {
    return this.has(key) ? this.require(key) : this.set(key, create());
  }
  clearVirtualContext(): void {}
  setVirtualContext(): void {}
  *entries(): Generator<readonly [unknown, unknown]> {}
}

function eveContextStorage(): AsyncLocalStorage<unknown> {
  const g = globalThis as Record<PropertyKey, unknown>;
  const key = Symbol.for("eve.context-storage");
  g[key] ??= new AsyncLocalStorage();
  return g[key] as AsyncLocalStorage<unknown>;
}

class FakeSandbox {
  readonly files = new Map<string, string>();
  readonly locked = new Set<string>();
  writes = 0;
  runs = 0;

  async writeTextFile({ path, content }: { path: string; content: string }): Promise<void> {
    this.files.set(path, content);
    this.writes++;
  }
  async readTextFile({ path }: { path: string }): Promise<string | null> {
    return this.files.get(path) ?? null;
  }
  async run({ command }: { command: string }): Promise<{ stdout: string }> {
    this.runs++;
    const lock = command.match(/^chmod -R a-w '(.+)'$/);
    if (lock) this.locked.add(lock[1]);
    return { stdout: "" };
  }
}

const BRAIN_SECRET = "CANARY-brain-body: the payments team decided to cap refunds at 5";
const RO_SECRET = "CANARY-readonly-body: acme corp's private baseline note";
const FLAKY_ERROR_SECRET = "CANARY-provider-error: 401 {\"message\":\"acme private workspace\"}";

interface FakeStore {
  provider: MemoryProvider;
  calls: { readTier: number; ensureTier: number; writeTier: number; tierVersion: number };
  tiers: Map<string, { files: MemoryFiles; version: number }>;
}

function makeFakeProvider(id: string): FakeStore {
  const tiers = new Map<string, { files: MemoryFiles; version: number }>();
  const calls = { readTier: 0, ensureTier: 0, writeTier: 0, tierVersion: 0 };
  const provider: MemoryProvider = {
    id,
    async readTier(_p: Partition, tier: Tier) {
      calls.readTier++;
      return { ...(tiers.get(tierId(tier))?.files ?? {}) };
    },
    async ensureTier(_p: Partition, tier: Tier) {
      calls.ensureTier++;
      return { ...(tiers.get(tierId(tier))?.files ?? {}) };
    },
    async writeTier() {
      calls.writeTier++;
      return null;
    },
    async deleteTier() {},
  };
  return { provider, calls, tiers };
}

const brain = makeFakeProvider("timing-brain");
const roStore = makeFakeProvider("timing-ro");
registerProvider(brain.provider);
registerProvider(roStore.provider);

const brokenProvider: MemoryProvider = {
  id: "timing-broken",
  async readTier() {
    throw new Error(FLAKY_ERROR_SECRET);
  },
  async ensureTier() {
    throw new Error(FLAKY_ERROR_SECRET);
  },
  async writeTier() {
    return null;
  },
  async deleteTier() {},
};
registerProvider(brokenProvider);

const BRAIN_FILES: MemoryFiles = { "MEMORY.md": `# brain\n`, "decisions.md": `${BRAIN_SECRET}\n` };
const RO_FILES: MemoryFiles = { "MEMORY.md": `# baseline\n${RO_SECRET}\n` };
brain.tiers.set(tierId(siloTier("timing-brain-silo")), { files: BRAIN_FILES, version: 1 });
roStore.tiers.set(tierId(siloTier("timing-ro-silo")), { files: RO_FILES, version: 1 });

registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [
    { name: "payments", channels: ["slack/T1/C1"], memory: ["timing-brain-silo", "timing-ro-silo"] },
    { name: "broken", channels: ["slack/T1/C2"], memory: ["timing-broken-silo"] },
  ],
  loadSilos: () => [
    { name: "timing-brain-silo", provider: "timing-brain" },
    { name: "timing-ro-silo", provider: "timing-ro", readOnly: true },
    { name: "timing-broken-silo", provider: "timing-broken" },
  ],
  domainsForSurface: () => ["payments"],
} as Parameters<typeof registerConfig>[0]);

const hook = memoryHook as unknown as {
  events: Record<string, (event: unknown, ctx: HookContext) => void | Promise<void>>;
};

function makeCtx(sessionId: string, sandbox: FakeSandbox, attrs: Record<string, string> = {}): HookContext {
  return {
    agent: { name: "test" },
    channel: { kind: "slack", continuationToken: "1719000000.1" },
    session: {
      id: sessionId,
      auth: {
        current: {
          principalId: "U7",
          principalType: "slack-user",
          attributes: {
            team_id: "T1",
            channel_id: "C1",
            channel_type: "channel",
            is_private: "false",
            is_ext_shared: "false",
            trust_checked: "true",
            user_id: "U7",
            ...attrs,
          },
        },
      },
    },
    getSandbox: async () => sandbox,
  } as unknown as HookContext;
}

async function fireStart(sessionId: string, attrs: Record<string, string> = {}): Promise<FakeSandbox> {
  const sandbox = new FakeSandbox();
  const als = new FakeEveContext();
  await eveContextStorage().run(als, async () => {
    await hook.events["session.started"]({ type: "session.started" }, makeCtx(sessionId, sandbox, attrs));
  });
  return sandbox;
}

async function syncRows(): Promise<AuditWireEntry[]> {
  return (await readAudit({ action: MEMORY_SYNC_TIMING_ACTION })) as unknown as AuditWireEntry[];
}

{
  ok(memorySyncTimingEnabled() === false, "OE_MEMORY_SYNC_TIMING defaults OFF (a measurement flag is opt-in)");
  ok(startMemorySyncTiming() === null, "flag OFF ⇒ startMemorySyncTiming() returns NULL, not a no-op collector — nothing is allocated on the default path");
  process.env[OE_MEMORY_SYNC_TIMING_ENV] = "0";
  ok(startMemorySyncTiming() === null, "only the literal '1' arms it (a stray '0' does not)");
  delete process.env[OE_MEMORY_SYNC_TIMING_ENV];
  ok(DRIVER_ACTION === MEMORY_SYNC_TIMING_ACTION, "the e2e driver's duplicated action key still matches the producer's exported constant");
}

let offCounts: { readTier: number; ensureTier: number; roReads: number; writes: number; runs: number };
{
  const before = (await syncRows()).length;
  const r0 = brain.calls.readTier;
  const e0 = brain.calls.ensureTier;
  const ro0 = roStore.calls.readTier;
  const sandbox = await fireStart("sess-off");
  ok((await syncRows()).length === before, "flag OFF ⇒ NO memory.sync_timing row is written (opt-in row volume)");
  ok(sandbox.files.has("memory/timing-brain-silo/decisions.md"), "…and the sync itself still happened (the instrumentation is the only thing gated)");
  offCounts = {
    readTier: brain.calls.readTier - r0,
    ensureTier: brain.calls.ensureTier - e0,
    roReads: roStore.calls.readTier - ro0,
    writes: sandbox.writes,
    runs: sandbox.runs,
  };
}

process.env[OE_MEMORY_SYNC_TIMING_ENV] = "1";
let armedRow: AuditWireEntry;
{
  const readsBefore = brain.calls.readTier;
  const ensuresBefore = brain.calls.ensureTier;
  const roReadsBefore = roStore.calls.readTier;
  const sandbox = await fireStart("sess-on");
  const rows = (await syncRows()).filter((r) => r.detail?.sessionId === "sess-on");
  ok(rows.length === 1, `flag ON ⇒ exactly ONE row per session (not one per silo, not one per message); got ${rows.length}`);
  armedRow = rows[0];

  ok(brain.calls.readTier - readsBefore === offCounts.readTier, "arming adds no extra provider readTier — the same write-tier baseline read, no more");
  ok(brain.calls.ensureTier - ensuresBefore === offCounts.ensureTier, "arming adds no extra provider ensureTier — instrumentation measures the work, it does not do more of it");
  ok(roStore.calls.readTier - roReadsBefore === offCounts.roReads, "…and no extra read of the read-only silo either");
  ok(sandbox.writes === offCounts.writes && sandbox.runs === offCounts.runs, "arming adds no extra sandbox writes or runs");

  const d = armedRow.detail as Record<string, unknown>;
  ok(d["sessionId"] === "sess-on", "the row names its session — the join key into the transcript");
  ok(typeof d["hookMs"] === "number" && (d["hookMs"] as number) >= 0, "hookMs is a finite non-negative duration (the whole session.started handler)");
  ok(typeof d["sandboxMs"] === "number" && (d["sandboxMs"] as number) >= 0, "sandboxMs is recorded ONCE per session — the cold-create number that separates 'sandbox is slow' from 'memory fetch is slow'");
  ok(typeof d["baselineMs"] === "number", "baselineMs is recorded — the write-tier baseline read+hash is a real boot cost the old story omitted entirely");
  ok(typeof d["indexMs"] === "number", "indexMs is recorded — rendering + writing + locking MEMORY.md is also inside boot");
  ok(d["siloCount"] === 2, `one entry per READ silo; got ${String(d["siloCount"])}`);

  const silos = d["silos"] as Record<string, unknown>[];
  const brainRow = silos.find((s) => s["silo"] === "timing-brain-silo");
  const roRow = silos.find((s) => s["silo"] === "timing-ro-silo");
  ok(!!brainRow && !!roRow, "both silos are named (silo NAME is config, not content)");
  ok(brainRow!["provider"] === "timing-brain" && brainRow!["tier"] === tierId(siloTier("timing-brain-silo")), "each entry carries its provider id + tier id");
  ok(brainRow!["files"] === 2 && brainRow!["bytes"] === byteSize(BRAIN_FILES), `bytes is the real materialised SIZE (${byteSize(BRAIN_FILES)}), a count — never the bytes themselves`);
  ok(roRow!["readOnly"] === true && typeof roRow!["lockMs"] === "number", "a read-only tier records its chmod lock cost; a writable one has none");
  ok(brainRow!["lockMs"] === undefined, "a writable tier emits no lockMs key at all (a null is dropped, not recorded)");
  for (const s of silos) {
    ok(typeof s["loadMs"] === "number" && (s["loadMs"] as number) >= 0, `${String(s["silo"])}: loadMs (the PROVIDER fetch) is finite and non-negative`);
    ok(typeof s["syncMs"] === "number" && (s["syncMs"] as number) >= 0, `${String(s["silo"])}: syncMs (syncTierIntoSandbox) is finite and non-negative`);
    ok(s["ok"] === true, `${String(s["silo"])}: materialised successfully`);
  }
}

function leakSurfaceOf(row: unknown): string {
  const found: string[] = [];
  const walk = (value: unknown, key: string): void => {
    if (typeof value === "string") {
      if (key !== "ts") found.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, key);
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) walk(v, k);
    }
  };
  walk(row, "");
  return found.join("\n");
}

{
  const serialised = JSON.stringify(armedRow);
  ok(!serialised.includes(BRAIN_SECRET), "TAINT: a memory file's BODY appears nowhere in the row");
  ok(!serialised.includes(RO_SECRET), "TAINT: a read-only silo's body appears nowhere in the row either");
  ok(!serialised.includes("CANARY"), "TAINT: no canary content string of any kind survives into the row");
  ok(isTaintCleanDetail(armedRow.detail), "TAINT: the emitted detail passes the independent verifier (allowlisted keys, scalar values only)");

  const hostile = {
    sessionId: "s1",
    hookMs: 10,
    baselineMs: 1,
    sandboxMs: 2,
    indexMs: 3,
    versionsMs: null,
    firstMessage: BRAIN_SECRET,
    indexContent: RO_SECRET,
    error: FLAKY_ERROR_SECRET,
    silos: [
      {
        silo: "s",
        tier: "silo:s",
        provider: "p",
        readOnly: false,
        loadMs: 1,
        syncMs: 1,
        lockMs: null,
        files: 1,
        bytes: 1,
        ok: true,
        contents: BRAIN_SECRET,
        sample: { body: RO_SECRET },
        paths: ["MEMORY.md", RO_SECRET],
      },
    ],
  } as unknown as MemorySyncTiming;
  const projected = toAuditDetail(hostile);
  const projectedJson = JSON.stringify(projected);
  ok(!projectedJson.includes("CANARY"), "TAINT: content smuggled into unknown record fields is DROPPED by the allowlist reconstruction, at both levels");
  ok(Object.keys(projected).every((k) => (SYNC_DETAIL_KEYS as readonly string[]).includes(k)), "TAINT: the row's top-level keys are exactly the allowlist");
  const pSilo = (projected["silos"] as Record<string, unknown>[])[0];
  ok(Object.keys(pSilo).every((k) => (SILO_DETAIL_KEYS as readonly string[]).includes(k)), "TAINT: a per-silo entry's keys are exactly the allowlist");
  ok(isTaintCleanDetail(projected), "TAINT: the hostile record still projects to a taint-clean detail");

  const smuggled = toAuditDetail({
    sessionId: `line1\nline2 ${BRAIN_SECRET}`,
    hookMs: 1,
    baselineMs: null,
    sandboxMs: null,
    indexMs: null,
    versionsMs: null,
    silos: [{ silo: "x".repeat(500), tier: "t", provider: "p", readOnly: false, loadMs: 0, syncMs: 0, lockMs: null, files: 0, bytes: 0, ok: true }],
  } as unknown as MemorySyncTiming);
  ok(smuggled["sessionId"] === undefined, "TAINT: a multi-line value in an identifier slot is REFUSED, not truncated-and-kept");
  ok((smuggled["silos"] as Record<string, unknown>[])[0]["silo"] === undefined, "TAINT: an over-long value in an identifier slot is refused too (identifiers are bounded)");
  ok(!isTaintCleanDetail({ sessionId: "s", silos: [{ silo: "s", body: "x" }] }), "TAINT: the verifier REJECTS an unknown per-silo key — it is a second opinion, not a restatement");
  ok(!isTaintCleanDetail({ sessionId: "s", silos: [{ silo: { nested: "x" } }] }), "TAINT: the verifier rejects a nested object in a silo slot");
  ok(!isTaintCleanDetail({ notAKey: 1 }), "TAINT: the verifier rejects an unknown top-level key");
}

{
  const sandbox = await fireStart("sess-broken", { channel_id: "C2" });
  const rows = (await syncRows()).filter((r) => r.detail?.sessionId === "sess-broken");
  ok(rows.length === 1, "a session whose only silo FAILED still emits its timing row");
  const silos = rows[0].detail?.["silos"] as Record<string, unknown>[];
  ok(silos.length === 1 && silos[0]["ok"] === false, "the failed silo is recorded as ok:false — a slow FAILING silo still spent boot time");
  ok(typeof silos[0]["loadMs"] === "number" && (silos[0]["loadMs"] as number) >= 0, "…with the time it burned before throwing (that is the number worth having)");
  ok(silos[0]["files"] === 0 && silos[0]["bytes"] === 0, "a failed silo materialised nothing");
  const brokenSurface = leakSurfaceOf(rows[0]);
  ok(!brokenSurface.includes("CANARY"), "TAINT: the provider's error text — which can quote a response BODY — is not in the row");
  ok(!brokenSurface.includes("401"), "TAINT: no fragment of the provider error survives");
  ok(!brokenSurface.includes("acme private workspace"), "TAINT: the response BODY the error quoted is not in the row either");
  const planted = JSON.parse(JSON.stringify(rows[0])) as { detail: Record<string, unknown> };
  (planted.detail["silos"] as Record<string, unknown>[])[0]["silo"] = FLAKY_ERROR_SECRET;
  const plantedSurface = leakSurfaceOf(planted);
  ok(
    plantedSurface.includes("CANARY") && plantedSurface.includes("401") && plantedSurface.includes("acme private workspace"),
    "TAINT (negative control): plant the provider error into a string field and all three hunts DO trip — the narrowed search still has teeth",
  );
  const numeric = JSON.parse(JSON.stringify(rows[0])) as { ts: string; detail: Record<string, unknown> };
  numeric.ts = "2026-03-26T22:06:42.401Z";
  (numeric.detail["silos"] as Record<string, unknown>[])[0]["loadMs"] = 401;
  numeric.detail["hookMs"] = 1401;
  ok(
    !leakSurfaceOf(numeric).includes("401"),
    "TAINT: a row whose TIMESTAMP and DURATIONS spell \"401\" does NOT trip the hunt — a number cannot carry error text, and the old whole-JSON search read one as a leak",
  );
  ok(sandbox.files.has("memory/MEMORY.md"), "…and the index was still written (per-silo isolation unchanged)");
}

{
  const rows = await syncRows();
  const events = [
    { index: 0, at: "2026-02-27T06:20:08.000Z", type: "session.started", data: {} },
    { index: 1, at: "2026-02-27T06:20:10.200Z", type: "turn.started", data: { turnId: "t1" } },
    { index: 2, at: "2026-02-27T06:20:10.300Z", type: "step.started", data: { turnId: "t1", stepIndex: 0 } },
  ];
  const session = decomposeSession(events);
  ok(session.bootMs === 2200, "the transcript half is unchanged — boot is still session.started → first turn.started");

  const sync = projectMemorySync(rows, "sess-on");
  ok(sync !== null && sync.silos.length === 2, "the driver projects the row back into a per-silo decomposition");
  const attribution = attributeBoot(session, rows, "sess-on")!;
  ok(attribution !== null, "attributeBoot returns a split when the row is present");
  ok(attribution.bootMs === 2200 && attribution.hookMs === sync!.hookMs, "the split carries both sides of the subtraction");
  ok(attribution.unattributedMs === 2200 - (sync!.hookMs ?? 0), "bootMs = memory-hook cost + the OTHER session.started work — the ceiling is now an attribution");
  ok(attribution.sandboxMs !== null && attribution.siloMs !== null, "sandbox cold-create and Σ per-silo cost are SEPARATE numbers — the confusion this exists to end");
  ok(attribution.silos[0].totalMs! >= attribution.silos[1].totalMs!, "silos come back slowest-first — 'which silo cost the boot' is answerable");
  ok(attribution.gaps.length === 0, "a complete join reports no gaps");
  ok(renderBootAttribution(attribution).some((l) => l.includes("sandbox-create")), "the render names the sandbox cold-create explicitly");
  ok(!JSON.stringify(renderBootAttribution(attribution)).includes("CANARY"), "TAINT: the rendered lines carry names + durations only");

  ok(projectMemorySync(rows, "no-such-session") === null, "an absent row projects to NULL — the default (flag off) state is not a fault");
  ok(attributeBoot(session, [], "sess-on") === null, "attributeBoot returns null with no row, so bootMs stays the ceiling it always was");
  ok(attributeBoot(session, rows, "sess-broken")!.gaps.some((g) => g.includes("FAILED")), "a failed silo is a NAMED gap in the attribution, not a silent null");
}

delete process.env[OE_MEMORY_SYNC_TIMING_ENV];

console.log(`\n✓ memory-sync-timing: ${n} assertions passed (flag OFF is a structural no-op + no row; flag ON emits one per-session row with per-silo load/sync/lock/files/bytes + the once-per-session sandbox cold-create; work is unchanged by arming; TAINT holds — bodies, unknown fields and provider error text all refused; boot decomposes into hook + unattributed)\n`);
