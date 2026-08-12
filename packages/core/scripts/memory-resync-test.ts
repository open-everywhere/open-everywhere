process.env.OE_SQLITE_PATH = ":memory:";

import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import memoryHook from "../agent/hooks/memory.js";
import { registerConfig } from "../agent/access/config.js";
import { registerProvider, type MemoryProvider } from "../agent/memory/provider.js";
import { siloTier, tierId, type MemoryFiles, type Tier } from "../agent/memory/store.js";
import { resolvePartition, type Partition } from "../agent/memory/partition.js";
import { readAudit } from "../agent/audit/audit.js";
import type { HookContext } from "eve/hooks";

import { registerSlackFixtureMapper } from "./_slack-test-stubs.js";
import { overrideSettingsForTest } from "../agent/settings/settings.js";
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
  failWrites = false;

  private isLocked(path: string): boolean {
    for (const l of this.locked) if (path === l || path.startsWith(`${l}/`)) return true;
    return false;
  }
  async writeTextFile({ path, content }: { path: string; content: string }): Promise<void> {
    if (this.failWrites) throw new Error(`simulated sandbox transport error writing '${path}'`);
    if (this.isLocked(path)) throw new Error(`EACCES: '${path}' is read-only`);
    this.files.set(path, content);
    this.writes++;
  }
  async readTextFile({ path }: { path: string }): Promise<string | null> {
    return this.files.has(path) ? (this.files.get(path) as string) : null;
  }
  async run({ command }: { command: string }): Promise<{ stdout: string }> {
    this.runs++;
    const lock = command.match(/^chmod -R a-w '(.+)'$/);
    if (lock) {
      this.locked.add(lock[1]);
      return { stdout: "" };
    }
    const unlock = command.match(/^chmod -R u\+w '(.+)'$/);
    if (unlock) {
      this.locked.delete(unlock[1]);
      return { stdout: "" };
    }
    const list = command.match(/^cd (\S+) 2>\/dev\/null && find \. -type f/);
    if (list) {
      const dir = list[1];
      const rels = [...this.files.keys()].filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1));
      return { stdout: rels.join("\n") };
    }
    if (command.startsWith("rm -rf ")) {
      for (const m of command.matchAll(/'([^']+)'/g)) {
        const dir = m[1];
        for (const k of [...this.files.keys()]) if (k === dir || k.startsWith(`${dir}/`)) this.files.delete(k);
        this.locked.delete(dir);
      }
      return { stdout: "" };
    }
    if (command.startsWith("rm -f ")) {
      for (const m of command.matchAll(/'([^']+)'/g)) this.files.delete(m[1]);
      return { stdout: "" };
    }
    return { stdout: "" };
  }
}

interface FakeStore {
  provider: MemoryProvider;
  calls: { readTier: number; ensureTier: number; writeTier: number; tierVersion: number };
  tiers: Map<string, { files: MemoryFiles; version: number }>;
}

function makeFakeProvider(id: string, withProbe: boolean): FakeStore {
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
      const t = tiers.get(tierId(tier));
      if (t && Object.keys(t.files).length > 0) return { ...t.files };
      const seed: MemoryFiles = { "MEMORY.md": `# ${tierId(tier)}\n` };
      tiers.set(tierId(tier), { files: seed, version: (t?.version ?? 0) + 1 });
      return { ...seed };
    },
    async writeTier(_p: Partition, tier: Tier, files: MemoryFiles) {
      calls.writeTier++;
      const t = tiers.get(tierId(tier)) ?? { files: {}, version: 0 };
      if (!Object.entries(files).some(([rel, c]) => t.files[rel] !== c)) return null;
      t.files = { ...t.files, ...files };
      t.version += 1;
      tiers.set(tierId(tier), t);
      return String(t.version);
    },
    async deleteFile(_p: Partition, tier: Tier, relPath: string) {
      const t = tiers.get(tierId(tier));
      if (!t || !(relPath in t.files)) return null;
      const files = { ...t.files };
      delete files[relPath];
      t.files = files;
      t.version += 1;
      tiers.set(tierId(tier), t);
      return String(t.version);
    },
    async deleteTier() {},
  };
  if (withProbe) {
    (provider as { tierVersion?: MemoryProvider["tierVersion"] }).tierVersion = async (_p: Partition, tier: Tier) => {
      calls.tierVersion++;
      const t = tiers.get(tierId(tier));
      return t ? String(t.version) : null;
    };
  }
  return { provider, calls, tiers };
}

const brain = makeFakeProvider("fake-brain", true);
const roStore = makeFakeProvider("fake-ro", true);
const noProbe = makeFakeProvider("fake-noprobe", false);
const engStore = makeFakeProvider("fake-eng", true);
const pubStore = makeFakeProvider("fake-public", true);

registerProvider(brain.provider);
registerProvider(roStore.provider);
registerProvider(noProbe.provider);
registerProvider(engStore.provider);
registerProvider(pubStore.provider);

let flakyBroken = true;
const flakyTiers = new Map<string, { files: MemoryFiles; version: number }>([
  [tierId(siloTier("flaky-silo")), { files: { "MEMORY.md": "# flaky healed\n" }, version: 1 }],
]);
const flakyProvider: MemoryProvider = {
  id: "fake-flaky",
  async readTier(_p: Partition, tier: Tier) {
    if (flakyBroken) throw new Error("flaky source down");
    return { ...(flakyTiers.get(tierId(tier))?.files ?? {}) };
  },
  async ensureTier(_p: Partition, tier: Tier) {
    if (flakyBroken) throw new Error("flaky source down");
    return { ...(flakyTiers.get(tierId(tier))?.files ?? {}) };
  },
  async writeTier() {
    return null;
  },
  async deleteTier() {},
  async tierVersion(_p: Partition, tier: Tier) {
    if (flakyBroken) throw new Error("flaky source down");
    const t = flakyTiers.get(tierId(tier));
    return t ? String(t.version) : null;
  },
};
registerProvider(flakyProvider);

let domains: { name: string; channels?: string[]; match?: string; memory?: string[]; ambientSupervisor?: boolean }[] = [
  {
    name: "payments",
    channels: ["slack/T1/C1"],
    memory: ["brain-silo", "baseline-silo", "noprobe-silo"],
    ambientSupervisor: true,
  },
  {
    name: "eng",
    channels: ["slack/T1/C2"],
    memory: ["eng-silo"],
    ambientSupervisor: true,
  },
  { name: "heal", channels: ["slack/T1/C3"], memory: ["flaky-silo"], ambientSupervisor: true },
  { name: "public", match: "public", memory: ["public-silo"] },
];

registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => domains,
  loadSilos: () => [
    { name: "brain-silo", provider: "fake-brain" },
    { name: "baseline-silo", provider: "fake-ro", readOnly: true },
    { name: "noprobe-silo", provider: "fake-noprobe" },
    { name: "eng-silo", provider: "fake-eng" },
    { name: "public-silo", provider: "fake-public", readOnly: true },
    { name: "flaky-silo", provider: "fake-flaky", readOnly: true },
  ],
  domainsForSurface: () => ["payments"],
} as Parameters<typeof registerConfig>[0]);

roStore.tiers.set(tierId(siloTier("baseline-silo")), { files: { "MEMORY.md": "# baseline v1\n" }, version: 1 });
noProbe.tiers.set(tierId(siloTier("noprobe-silo")), { files: { "MEMORY.md": "# noprobe v1\n" }, version: 1 });
engStore.tiers.set(tierId(siloTier("eng-silo")), { files: { "MEMORY.md": "# eng v1\n" }, version: 1 });
pubStore.tiers.set(tierId(siloTier("public-silo")), { files: { "MEMORY.md": "# public v1\n" }, version: 1 });

const hook = memoryHook as unknown as {
  events: Record<string, (event: unknown, ctx: HookContext) => void | Promise<void>>;
};

function makeCtx(
  sessionId: string,
  continuationToken: string,
  sandbox: FakeSandbox,
  attrs: Record<string, string> = {},
): HookContext {
  return {
    agent: { name: "test" },
    channel: { kind: "slack", continuationToken },
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

interface Sim {
  readonly ctx: HookContext;
  readonly sandbox: FakeSandbox;
  readonly als: FakeEveContext;
}

function makeSession(sessionId: string, continuationToken: string, attrs: Record<string, string> = {}): Sim {
  const sandbox = new FakeSandbox();
  return { ctx: makeCtx(sessionId, continuationToken, sandbox, attrs), sandbox, als: new FakeEveContext() };
}

async function fire(sim: Sim, event: string): Promise<void> {
  await eveContextStorage().run(sim.als, async () => {
    await hook.events[event]({ type: event }, sim.ctx);
  });
}

const SUP_TOKEN = "C1:oe-sup:g1";
const BRAIN = siloTier("brain-silo");
const partition = resolvePartition(makeCtx("p", SUP_TOKEN, new FakeSandbox()));

ok(typeof hook.events["turn.started"] === "function", "the memory hook registers a turn.started handler");

overrideSettingsForTest({ window: { topology: true } });
{
  const s = makeSession("sup-1", SUP_TOKEN);
  await fire(s, "session.started");
  ok(s.sandbox.files.get("memory/brain-silo/MEMORY.md") === "# silo:brain-silo\n", "session.started materialises the writable brain (seed)");
  ok(s.sandbox.files.get("memory/noprobe-silo/MEMORY.md") === "# noprobe v1\n", "session.started materialises the probe-less silo");

  await brain.provider.writeTier(partition, BRAIN, { "decisions.md": "we decided: cap at 5" }, "concurrent write");
  ok(s.sandbox.files.get("memory/brain-silo/decisions.md") === undefined, "before turn.started the concurrent decision is INVISIBLE (the F8 staleness)");

  await fire(s, "turn.started");
  ok(s.sandbox.files.get("memory/brain-silo/decisions.md") === "we decided: cap at 5", "turn.started re-materialises the advanced silo — the concurrent decision is now VISIBLE");

  const reads = brain.calls.readTier;
  const probes = brain.calls.tierVersion;
  const writes = s.sandbox.writes;
  await fire(s, "turn.started");
  ok(brain.calls.tierVersion === probes + 1, "an unchanged turn still probes the version (the cheap check)");
  ok(brain.calls.readTier === reads, "an UNCHANGED silo is skipped — zero content re-pull (version gate)");
  ok(s.sandbox.writes === writes, "an unchanged turn writes nothing into the sandbox");

  const npReads = noProbe.calls.readTier;
  await noProbe.provider.writeTier(partition, siloTier("noprobe-silo"), { "MEMORY.md": "# noprobe v2\n" }, "concurrent");
  await fire(s, "turn.started");
  ok(noProbe.calls.readTier === npReads && noProbe.calls.tierVersion === 0, "a provider WITHOUT tierVersion is never probed or re-pulled mid-session");
  ok(s.sandbox.files.get("memory/noprobe-silo/MEMORY.md") === "# noprobe v1\n", "the probe-less silo keeps its session-start snapshot (documented limitation, not a cost hole)");
}

{
  const s = makeSession("sup-2", SUP_TOKEN);
  await fire(s, "session.started");
  ok(s.sandbox.locked.has("memory/baseline-silo"), "session.started locks the read-only tier");
  await roStore.provider.writeTier(partition, siloTier("baseline-silo"), { "MEMORY.md": "# baseline v2\n" }, "concurrent");
  await fire(s, "turn.started");
  const md = s.sandbox.files.get("memory/baseline-silo/MEMORY.md") ?? "";
  ok(md.includes("# baseline v2"), "a read-only silo refreshes too (unlock let the host rewrite it)");
  ok(md.startsWith("<!-- READ-ONLY"), "the refreshed read-only copy keeps its banner");
  ok(s.sandbox.locked.has("memory/baseline-silo"), "the tier is RE-LOCKED after the refresh (fail-loud posture restored)");
  await assert.rejects(
    () => s.sandbox.writeTextFile({ path: "memory/baseline-silo/MEMORY.md", content: "agent edit" }),
    /EACCES/,
    "agent edits to the refreshed read-only tier still fail loud",
  );
  n++;
}

{
  const s = makeSession("sup-3", SUP_TOKEN);
  await fire(s, "session.started");
  s.sandbox.files.set("memory/brain-silo/MEMORY.md", "# silo:brain-silo\n- my un-persisted bullet");
  await brain.provider.writeTier(partition, BRAIN, { "MEMORY.md": "# silo:brain-silo\n- concurrent bullet" }, "concurrent");
  await fire(s, "turn.started");
  ok(
    s.sandbox.files.get("memory/brain-silo/MEMORY.md") === "# silo:brain-silo\n- my un-persisted bullet",
    "a genuinely divergent agent edit is NOT clobbered by the refresh (conflict resolution stays at persist time)",
  );
}

{
  const s = makeSession("thread-1", "1718884080.123456");
  const probesBefore = brain.calls.tierVersion + roStore.calls.tierVersion;
  await fire(s, "session.started");
  ok(brain.calls.tierVersion + roStore.calls.tierVersion === probesBefore, "non-supervisor session.started records no version baseline (zero probes)");
  await brain.provider.writeTier(partition, BRAIN, { "thread-test.md": "written concurrently" }, "concurrent");
  const reads = brain.calls.readTier;
  const writes = s.sandbox.writes;
  const runs = s.sandbox.runs;
  await fire(s, "turn.started");
  ok(brain.calls.tierVersion + roStore.calls.tierVersion === probesBefore, "non-supervisor turn.started probes nothing");
  ok(brain.calls.readTier === reads && s.sandbox.writes === writes && s.sandbox.runs === runs, "non-supervisor turn.started takes ZERO provider/sandbox actions");
  ok(s.sandbox.files.get("memory/brain-silo/thread-test.md") === undefined, "non-supervisor session keeps today's session-start snapshot");
}

overrideSettingsForTest({ window: { topology: false } });
{
  const s = makeSession("sup-off", SUP_TOKEN);
  const probesBefore = brain.calls.tierVersion + roStore.calls.tierVersion;
  await fire(s, "session.started");
  ok(brain.calls.tierVersion + roStore.calls.tierVersion === probesBefore, "gate OFF: session.started records no version baseline (zero probes)");
  await brain.provider.writeTier(partition, BRAIN, { "gate-off.md": "invisible until session end" }, "concurrent");
  const reads = brain.calls.readTier;
  const writes = s.sandbox.writes;
  const runs = s.sandbox.runs;
  await fire(s, "turn.started");
  ok(brain.calls.tierVersion + roStore.calls.tierVersion === probesBefore, "gate OFF: turn.started probes nothing");
  ok(brain.calls.readTier === reads && s.sandbox.writes === writes && s.sandbox.runs === runs, "gate OFF: turn.started takes ZERO provider/sandbox actions — byte-identical to today");
  ok(s.sandbox.files.get("memory/brain-silo/gate-off.md") === undefined, "gate OFF: the supervisor keeps the session-start snapshot exactly as before this change");
}

overrideSettingsForTest({ window: { topology: true } });
{
  const s = makeSession("sup-lock", SUP_TOKEN);
  await fire(s, "session.started");
  ok(s.sandbox.locked.has("memory/baseline-silo"), "read-only baseline locked at session start");
  await roStore.provider.writeTier(partition, siloTier("baseline-silo"), { "MEMORY.md": "# baseline v-fail\n" }, "bump");
  s.sandbox.failWrites = true;
  await fire(s, "turn.started");
  s.sandbox.failWrites = false;
  ok(s.sandbox.locked.has("memory/baseline-silo"), "FIX-1: after a mid-refresh failure the read-only tier is STILL LOCKED (finally re-lock ran — no writable window)");
  await assert.rejects(
    () => s.sandbox.writeTextFile({ path: "memory/baseline-silo/notes.md", content: "sneak" }),
    /EACCES/,
    "FIX-1: an agent write to the tier still FAILS LOUD after the failed refresh (the silent-drop hole is closed)",
  );
  n++;
}

{
  const s = makeSession("sup-del", SUP_TOKEN);
  await fire(s, "session.started");
  await brain.provider.writeTier(partition, BRAIN, { "ghost.md": "to be deleted" }, "seed ghost");
  await fire(s, "turn.started");
  ok(s.sandbox.files.get("memory/brain-silo/ghost.md") === "to be deleted", "agent-untouched file present after the first resync (baselined)");
  await brain.provider.deleteFile!(partition, BRAIN, "ghost.md");
  await fire(s, "turn.started");
  ok(s.sandbox.files.get("memory/brain-silo/ghost.md") === undefined, "FIX-2: the upstream delete PROPAGATES — the file is removed from the sandbox (no longer model-visible)");
  await fire(s, "session.completed");
  ok(!("ghost.md" in brain.tiers.get(tierId(BRAIN))!.files), "FIX-2: persistMemoryNow does NOT resurrect the deleted file into the store (the {...host,...sandbox} union no longer re-adds it)");
}

{
  const s = makeSession("sup-del2", SUP_TOKEN);
  await fire(s, "session.started");
  await brain.provider.writeTier(partition, BRAIN, { "shared.md": "orig" }, "seed shared");
  await fire(s, "turn.started");
  ok(s.sandbox.files.get("memory/brain-silo/shared.md") === "orig", "shared file present + baselined");
  s.sandbox.files.set("memory/brain-silo/shared.md", "agent's WIP edit");
  await brain.provider.deleteFile!(partition, BRAIN, "shared.md");
  await fire(s, "turn.started");
  ok(
    s.sandbox.files.get("memory/brain-silo/shared.md") === "agent's WIP edit",
    "FIX-2: an agent-EDITED file deleted upstream is PRESERVED (hash≠baseline ⇒ un-persisted work, kept — same protection as the write path)",
  );
}

{
  const s = makeSession("sup-rodel", SUP_TOKEN);
  await fire(s, "session.started");
  await roStore.provider.writeTier(partition, siloTier("baseline-silo"), { "extra.md": "temp doc" }, "add extra");
  await fire(s, "turn.started");
  ok(s.sandbox.files.get("memory/baseline-silo/extra.md") === "temp doc", "read-only extra doc present after resync");
  await roStore.provider.deleteFile!(partition, siloTier("baseline-silo"), "extra.md");
  await fire(s, "turn.started");
  ok(s.sandbox.files.get("memory/baseline-silo/extra.md") === undefined, "FIX-2: an upstream delete on a READ-ONLY silo is propagated (stale file removed; read-only tiers have no agent divergence)");
  ok(s.sandbox.locked.has("memory/baseline-silo"), "the read-only tier remains LOCKED after the delete-propagating refresh");
}

{
  const pubP0 = pubStore.calls.tierVersion, brainP0 = brain.calls.tierVersion, engP0 = engStore.calls.tierVersion;
  const ext = makeSession("sup-ext", "C9:oe-sup:g1", { channel_id: "C9", is_ext_shared: "true" });
  await fire(ext, "session.started");
  ok((ext.sandbox.files.get("memory/public-silo/MEMORY.md") ?? "").startsWith("<!-- READ-ONLY"), "external session materialises the read-only public silo");
  ok(ext.sandbox.files.get("memory/brain-silo/MEMORY.md") === undefined, "external session NEVER materialises an internal domain silo (trust gate at session.started)");
  await pubStore.provider.writeTier(partition, siloTier("public-silo"), { "MEMORY.md": "# public v2\n" }, "bump");
  await fire(ext, "turn.started");
  ok(pubStore.calls.tierVersion > pubP0, "external resync probes the public silo");
  ok(brain.calls.tierVersion === brainP0 && engStore.calls.tierVersion === engP0, "ISOLATION: an external resync NEVER probes an internal silo (the trust gate holds through re-sync too)");
  const extGate = (await readAudit({ action: "memory.trust_gate" })).find((e) => e.detail?.sessionId === "sup-ext");
  ok(!!extGate, "WS-4: an external session.started audits a memory.trust_gate row");
  ok(typeof extGate?.detail?.reason === "string" && typeof extGate?.detail?.reads === "number" && extGate?.detail?.sessionId === "sup-ext" && (extGate?.detail as { mode?: unknown }).mode !== undefined, "WS-4: the trust_gate detail carries mode/reads/reason/sessionId (taint-clean — no memory content)");

  const engP1 = engStore.calls.tierVersion;
  const a = makeSession("sup-a", SUP_TOKEN);
  await fire(a, "session.started");
  ok((await readAudit({ action: "memory.trust_gate" })).every((e) => e.detail?.sessionId !== "sup-a"), "WS-4: an internal (trusted) session.started writes NO memory.trust_gate row");
  await brain.provider.writeTier(partition, BRAIN, { "a-only.md": "x" }, "bump A");
  await fire(a, "turn.started");
  ok(engStore.calls.tierVersion === engP1, "ISOLATION: a domain-A supervisor never probes domain-B's silo");
  ok(a.sandbox.files.get("memory/eng-silo/MEMORY.md") === undefined, "ISOLATION: domain-B's silo is never present in a domain-A session's sandbox");
}

{
  flakyBroken = true;
  const s = makeSession("sup-heal", "C3:oe-sup:g1", { channel_id: "C3" });
  await fire(s, "session.started");
  const idx0 = s.sandbox.files.get("memory/MEMORY.md") ?? "";
  ok(idx0.includes("Unavailable this session") && idx0.includes("flaky-silo"), "session.started index marks the failed silo as Unavailable/MISSING");
  ok(s.sandbox.files.get("memory/flaky-silo/MEMORY.md") === undefined, "the failed silo did not materialise at session start");
  flakyBroken = false;
  await fire(s, "turn.started");
  ok((s.sandbox.files.get("memory/flaky-silo/MEMORY.md") ?? "").includes("# flaky healed"), "turn.started materialises the healed silo");
  const idx1 = s.sandbox.files.get("memory/MEMORY.md") ?? "";
  ok(!idx1.includes("Unavailable this session"), "NIT: the refreshed index DROPS the ⚠ Unavailable section once the silo heals");
  ok(idx1.includes("flaky-silo"), "NIT: the healed silo is now listed among the available silos");
}

{
  const BRAIN_TEXT = [
    "# payments brain",
    "- @ana owns the settlement runbook",
    "- refunds over 10k need a second approver",
    "- the FX cutover is 2026-08-01",
    "- never retry a capture without an idempotency key",
    "- the chargeback SLA is 5 working days",
  ].join("\n");
  await brain.provider.writeTier(partition, BRAIN, { "MEMORY.md": BRAIN_TEXT }, "seed the brain");
  const s = makeSession("sup-destroy", SUP_TOKEN);
  await fire(s, "session.started");
  ok(s.sandbox.files.get("memory/brain-silo/MEMORY.md") === BRAIN_TEXT, "the brain materialises for the session");

  s.sandbox.files.set("memory/brain-silo/MEMORY.md", "");
  await fire(s, "session.completed");

  const stored = brain.tiers.get(tierId(BRAIN))!.files;
  ok(stored["MEMORY.md"] === BRAIN_TEXT, "OPE-245: persistMemoryNow REFUSES the truncation — the domain's brain is intact in the store");
  const parked = Object.keys(stored).find((k) => k.includes(".rejected-"));
  ok(parked !== undefined && stored[parked] === "", "OPE-245: the refused version is parked as a `.rejected-` sibling (recoverable, not silently dropped)");
  const refusal = (await readAudit({ action: "memory.write_refused" })).find((r) => r.detail?.sessionId === "sup-destroy");
  ok(refusal !== undefined, "OPE-245: the refusal gets its OWN audit row (it must not depend on the memory.write row, which only fires when a write changed something)");
  const detail = JSON.stringify(refusal?.detail ?? {});
  ok(detail.includes("MEMORY.md") && !detail.includes("chargeback SLA"), "the refusal row carries file names + counts, never memory CONTENT (the taint rule)");
}

{
  const before = brain.tiers.get(tierId(BRAIN))!.files["MEMORY.md"];
  const s = makeSession("sup-append", SUP_TOKEN);
  await fire(s, "session.started");
  s.sandbox.files.set("memory/brain-silo/MEMORY.md", `${before}\n- the session learned a new thing`);
  await fire(s, "session.completed");
  ok(
    brain.tiers.get(tierId(BRAIN))!.files["MEMORY.md"] === `${before}\n- the session learned a new thing`,
    "OPE-245: the floor is not a blanket block — an ordinary APPEND from the same seat still persists",
  );
}

const DEFAULT_PAYMENTS_MEMORY = ["brain-silo", "baseline-silo", "noprobe-silo"];
const setPaymentsMemory = (memory: string[]) => {
  domains = domains.map((d) => (d.name === "payments" ? { ...d, memory } : d));
};
{
  const s = makeSession("sup-drop", SUP_TOKEN);
  await fire(s, "session.started");
  ok(!!s.sandbox.files.get("memory/brain-silo/MEMORY.md"), "G4 setup: the writable brain is materialised");
  ok(!!s.sandbox.files.get("memory/baseline-silo/MEMORY.md"), "G4 setup: the read-only baseline is materialised (and locked)");
  ok(s.sandbox.locked.has("memory/baseline-silo"), "G4 setup: the read-only tier is LOCKED — the removal has to unlock before it can rm");
  ok((s.sandbox.files.get("memory/MEMORY.md") ?? "").includes("baseline-silo"), "G4 setup: the index lists it");

  setPaymentsMemory(["brain-silo", "noprobe-silo"]);
  await fire(s, "turn.started");

  ok(s.sandbox.files.get("memory/baseline-silo/MEMORY.md") === undefined, "🔴 G4: a tier that dropped OUT of the plan is GONE from the live sandbox — un-vouching a surface no longer leaves its silo readable for the rest of the session");
  ok([...s.sandbox.files.keys()].every((k) => !k.startsWith("memory/baseline-silo")), "G4: the whole tier dir goes, not just the files the last sync happened to know about");
  ok(!s.sandbox.locked.has("memory/baseline-silo"), "G4: the removed read-only tier's lock entry goes with the dir (it was unlocked to be deleted, and there is nothing left to re-lock)");
  ok(!!s.sandbox.files.get("memory/brain-silo/MEMORY.md"), "🔴 G4: a STILL-PLANNED tier is untouched (the removal is a diff, not a wipe)");
  ok(!!s.sandbox.files.get("memory/noprobe-silo/MEMORY.md"), "G4: the probe-less silo — which the refresh half never touches — is also untouched by the removal");

  const idx = s.sandbox.files.get("memory/MEMORY.md") ?? "";
  ok(!idx.includes("baseline-silo"), "G4: the on-disk index stops listing the removed silo (otherwise the agent keeps citing a map to nothing and reads the empty grep as 'we never knew that')");
  ok(idx.includes("brain-silo"), "G4: …and still lists the silos that remain");
  const change = (await readAudit({ action: "memory.index_change" })).find((e) => Array.isArray((e.detail as { removed?: unknown })?.removed));
  ok((change?.detail as { removed?: string[] })?.removed?.includes("baseline-silo") === true, "G4: a memory.index_change row carries the removal — the wake-delta PUSH is the only signal the model gets that its frozen index snapshot moved");
  ok(JSON.stringify(change?.detail ?? {}).includes("baseline-silo") && !JSON.stringify(change?.detail ?? {}).includes("# baseline"), "G4: the row carries silo NAMES only, never memory content (the taint rule)");

  const runs = s.sandbox.runs;
  const writes = s.sandbox.writes;
  await fire(s, "turn.started");
  ok(s.sandbox.runs === runs && s.sandbox.writes === writes, "G4: a second turn on the same narrowed plan takes ZERO sandbox actions — the diff is against what is MATERIALISED, so it cannot re-remove or thrash");
}

{
  setPaymentsMemory(DEFAULT_PAYMENTS_MEMORY);
  const s = makeSession("sup-empty", SUP_TOKEN);
  await fire(s, "session.started");
  ok([...s.sandbox.files.keys()].some((k) => k.startsWith("memory/brain-silo")), "G4 empty-plan setup: silos are materialised");
  setPaymentsMemory([]);
  await fire(s, "turn.started");
  ok(
    [...s.sandbox.files.keys()].every((k) => k === "memory/MEMORY.md"),
    "🔴 G4: a plan that collapses to EMPTY un-materialises EVERYTHING — the `no reads ⇒ return early` path no longer strands a whole sandbox of memory",
  );
  ok((s.sandbox.files.get("memory/MEMORY.md") ?? "").length > 0, "G4: the index is still written (an empty map, not a stale one)");
  ok(!(s.sandbox.files.get("memory/MEMORY.md") ?? "").includes("brain-silo"), "G4: …and it names none of the removed silos");
  setPaymentsMemory(DEFAULT_PAYMENTS_MEMORY);
}

console.log(`\n✓ memory-resync: ${n} assertions passed (concurrent write visible on turn.started, version-gated skip, read-only relock, probe-less skip, edit-preserving refresh, non-supervisor + gate-off byte-identical; FIX-1 unlock-leak re-lock; FIX-2 delete propagation + no persist-resurrection + agent-edit preserved + read-only ghost removal; trust/domain isolation; failed-silo heal index refresh; OPE-245 destructive-write floor wired into persistMemoryNow + append still lands; OPE-300 G4 un-materialisation of dropped tiers)\n`);
