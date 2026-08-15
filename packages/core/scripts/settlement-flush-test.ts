import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-settlement-flush-")), "ops.sqlite3");
delete process.env.OE_ORG;

import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import memoryHook from "../agent/hooks/memory.js";
import spawnTaintHook from "../agent/hooks/spawn-taint.js";
import { conflictName } from "../agent/hooks/memory.js";
import { SETTLEMENT_FLUSH_ACTION } from "../agent/hooks/settlement-flush.js";
import { registerConfig } from "../agent/access/config.js";
import { defineDomain } from "../agent/memory/domain.js";
import { registerProvider, type MemoryProvider } from "../agent/memory/provider.js";
import { siloTier, tierId, type MemoryFiles, type Tier } from "../agent/memory/store.js";
import { type Partition } from "../agent/memory/partition.js";
import { readAudit, type AuditEntry } from "../agent/audit/audit.js";
import { deploymentOrg } from "../agent/identity/binding.js";
import { formatWindowToken } from "../agent/channels/window-key.js";
import type { HookContext } from "eve/hooks";

import { registerSlackFixtureMapper } from "./_slack-test-stubs.js";
registerSlackFixtureMapper();

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
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

  private isLocked(path: string): boolean {
    for (const l of this.locked) if (path === l || path.startsWith(`${l}/`)) return true;
    return false;
  }
  async writeTextFile({ path, content }: { path: string; content: string }): Promise<void> {
    if (this.isLocked(path)) throw new Error(`EACCES: '${path}' is read-only`);
    this.files.set(path, content);
  }
  async readTextFile({ path }: { path: string }): Promise<string | null> {
    return this.files.has(path) ? (this.files.get(path) as string) : null;
  }
  async run({ command }: { command: string }): Promise<{ stdout: string }> {
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
  childEdit(rel: string, content: string): void {
    this.files.set(`memory/${SILO}/${rel}`, content);
  }
  read(rel: string): string | undefined {
    return this.files.get(`memory/${SILO}/${rel}`);
  }
}

const SILO = "settle-silo";
const BRAIN: Tier = siloTier(SILO);
const tiers = new Map<string, { files: MemoryFiles; version: number }>();

const brainProvider: MemoryProvider = {
  id: "fake-brain-settle",
  async readTier(_p: Partition, tier: Tier) {
    return { ...(tiers.get(tierId(tier))?.files ?? {}) };
  },
  async ensureTier(_p: Partition, tier: Tier) {
    const t = tiers.get(tierId(tier));
    if (t && Object.keys(t.files).length > 0) return { ...t.files };
    const seed: MemoryFiles = { "MEMORY.md": `# ${tierId(tier)}\n` };
    tiers.set(tierId(tier), { files: seed, version: (t?.version ?? 0) + 1 });
    return { ...seed };
  },
  async writeTier(_p: Partition, tier: Tier, files: MemoryFiles) {
    const t = tiers.get(tierId(tier)) ?? { files: {}, version: 0 };
    if (!Object.entries(files).some(([rel, c]) => t.files[rel] !== c)) return null;
    t.files = { ...t.files, ...files };
    t.version += 1;
    tiers.set(tierId(tier), t);
    return String(t.version);
  },
  async deleteTier() {},
  async tierVersion(_p: Partition, tier: Tier) {
    const t = tiers.get(tierId(tier));
    return t ? String(t.version) : null;
  },
};
registerProvider(brainProvider);

function stored(): MemoryFiles {
  return { ...(tiers.get(tierId(BRAIN))?.files ?? {}) };
}
function conflictSiblings(): string[] {
  return Object.keys(stored()).filter((rel) => rel.includes(".conflict-"));
}

registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [defineDomain({ name: "payments", channels: ["slack/T1/C1"], memory: [SILO], ambientSupervisor: true, mode: "unified" })],
  loadSilos: () => [{ name: SILO, provider: "fake-brain-settle" }],
  domainsForSurface: () => ["payments"],
} as Parameters<typeof registerConfig>[0]);

const SEEDED = "# payments brain\n- pricing is reviewed quarterly\n";
tiers.set(tierId(BRAIN), { files: { "MEMORY.md": SEEDED }, version: 1 });

const memory = memoryHook as unknown as { events: Record<string, (event: unknown, ctx: HookContext) => void | Promise<void>> };
const taint = spawnTaintHook as unknown as { events: Record<string, (event: unknown, ctx: HookContext) => void | Promise<void>> };

const ORG = deploymentOrg();
const WINDOW = formatWindowToken({ domain: "payments", windowId: "payments", generation: 3 });
const SLACK_ATTRS: Record<string, string> = {
  team_id: "T1",
  channel_id: "C1",
  channel_type: "channel",
  is_private: "false",
  is_ext_shared: "false",
  trust_checked: "true",
  user_id: "U7",
};

interface Seat {
  readonly sessionId: string;
  readonly sandbox: FakeSandbox;
  readonly als: FakeEveContext;
  readonly ctx: HookContext;
}

function makeSeat(sessionId: string): Seat {
  const sandbox = new FakeSandbox();
  const ctx = {
    agent: { name: "test" },
    channel: { kind: "slack", continuationToken: `unified:${WINDOW}` },
    getSandbox: async () => sandbox,
    session: {
      id: sessionId,
      turn: { id: `${sessionId}-turn-1`, sequence: 1 },
      auth: { current: { principalId: "U7", principalType: "slack-user", attributes: { ...SLACK_ATTRS, oe_grain: "standing", oe_window_token: WINDOW } } },
    },
  } as unknown as HookContext;
  return { sessionId, sandbox, als: new FakeEveContext(), ctx };
}

async function inSession<T>(s: Seat, fn: () => Promise<T>): Promise<T> {
  return await eveContextStorage().run(s.als, fn);
}

async function fireMemory(s: Seat, event: string): Promise<void> {
  await inSession(s, async () => {
    await memory.events[event]({ type: event }, s.ctx);
  });
}

async function fireResult(s: Seat, result: unknown): Promise<void> {
  await inSession(s, async () => {
    await taint.events["action.result"]({ type: "action.result", data: { result } } as unknown as Parameters<(typeof taint.events)["action.result"]>[0], s.ctx);
  });
}

function receipt(taskId: string, callId: string): unknown {
  return {
    kind: "subagent-result",
    origin: "child",
    callId,
    subagentName: "worker",
    backgroundTask: { status: "working", taskId },
    outcome: { kind: "parked" },
    output: { agentId: `ag_${callId}`, status: "working", taskId },
  };
}

function peek(views: readonly { taskId: string; status: string }[]): unknown {
  return {
    kind: "tool-result",
    toolName: "task_peek",
    output: { tasks: views.map((v) => ({ taskId: v.taskId, status: v.status, metadata: { agentId: `ag_${v.taskId}`, kind: "delegated", mode: "background", name: "worker" } })) },
  };
}

function syncResult(callId: string): unknown {
  return { kind: "subagent-result", origin: "child", callId, subagentName: "worker", output: { text: "the child answered" } };
}

async function memoryWrites(sessionId: string): Promise<AuditEntry[]> {
  const rows = await readAudit({ action: "memory.write" });
  return rows.filter((r) => (r.detail as { sessionId?: string } | undefined)?.sessionId === sessionId);
}
async function flushRows(): Promise<AuditEntry[]> {
  return await readAudit({ action: SETTLEMENT_FLUSH_ACTION });
}

eq(ORG, deploymentOrg(), "harness: the org is the deployment default");

console.log("1. a terminal task view flushes the parent's tree to the host store:");
{
  const s = makeSeat("seat-settle");
  await fireMemory(s, "session.started");
  eq(s.sandbox.read("MEMORY.md"), SEEDED, "session.started materialises the silo into the parent's sandbox");

  await fireResult(s, receipt("task_A", "call_A"));

  const LEARNED = "# payments brain\n- pricing is reviewed MONTHLY (the worker corrected this)\n";
  s.sandbox.childEdit("MEMORY.md", LEARNED);

  eq(stored()["MEMORY.md"], SEEDED, "NEGATIVE CONTROL: the child's edit has NOT reached the store yet — the sandbox is not the store");
  eq((await memoryWrites(s.sessionId)).length, 0, "…and no memory.write row exists yet");

  await fireResult(s, peek([{ taskId: "task_A", status: "completed" }]));

  eq(stored()["MEMORY.md"], LEARNED, "🔴 THE FIX: the child's edit is IN THE STORE at settlement — not hours later at rotation");
  const writes = await memoryWrites(s.sessionId);
  eq(writes.length, 1, "the settlement flush emits exactly ONE memory.write row");
  eq((writes[0].detail as { outcome?: string }).outcome, "settled", '…stamped outcome:"settled" — the row distinguishes this flush from session end and from return_result');
  eq((writes[0].detail as { silo?: string }).silo, SILO, "…naming the silo it wrote (names + counts, never content)");

  const rows = (await flushRows()).filter((r) => (r.detail as { edge?: string }).edge === "task-settled");
  ok(rows.length >= 1, "the settlement flush writes its own audit row");
  eq((rows[rows.length - 1].detail as { outcome?: string }).outcome, "flushed", "…recording that the flush RAN (not that the guard held it)");
  eq((rows[rows.length - 1].detail as { flush?: { changed?: number } }).flush?.changed, 1, "…and carrying the persist COUNTS — one silo genuinely changed");
}

console.log("2. the fan-out guard skips the flush while another delegated task still holds the tree:");
{
  const s = makeSeat("seat-fanout");
  await fireMemory(s, "session.started");
  const HOST_BEFORE = stored()["MEMORY.md"];

  await fireResult(s, receipt("task_B1", "call_B1"));
  await fireResult(s, receipt("task_B2", "call_B2"));

  const HALF_WRITTEN = `${HOST_BEFORE}- a line child B2 is only halfway through writ`;
  s.sandbox.childEdit("MEMORY.md", HALF_WRITTEN);

  await fireResult(s, peek([{ taskId: "task_B1", status: "completed" }]));

  eq(stored()["MEMORY.md"], HOST_BEFORE, "🔴 THE GUARD: the half-written file did NOT reach the store — a live sibling holds the tree");
  eq((await memoryWrites(s.sessionId)).length, 0, "…so no memory.write row was emitted");
  const skips = (await flushRows()).filter((r) => (r.detail as { outcome?: string }).outcome === "skipped");
  ok(skips.length >= 1, "the SKIP is audited — the store staying stale on purpose must be visible, never silent");
  eq((skips[skips.length - 1].detail as { liveTasks?: number }).liveTasks, 1, "…naming how many tasks still held the tree");

  const WHOLE = `${HOST_BEFORE}- a line child B2 finished writing\n`;
  s.sandbox.childEdit("MEMORY.md", WHOLE);
  await fireResult(s, peek([{ taskId: "task_B2", status: "completed" }]));

  eq(stored()["MEMORY.md"], WHOLE, "…and once the LAST task settles the flush runs, landing the WHOLE file");
  const writes = await memoryWrites(s.sessionId);
  eq(writes.length, 1, "exactly one memory.write row — the skipped attempt wrote nothing");
  eq((writes[0].detail as { outcome?: string }).outcome, "settled", "…stamped settled");
}

console.log("3. a non-terminal view in the same peek arms the guard:");
{
  const s = makeSeat("seat-working");
  await fireMemory(s, "session.started");
  const HOST_BEFORE = stored()["MEMORY.md"];
  const EDIT = `${HOST_BEFORE}- something a child wrote\n`;
  s.sandbox.childEdit("MEMORY.md", EDIT);

  await fireResult(s, peek([{ taskId: "task_C1", status: "completed" }, { taskId: "task_C2", status: "working" }]));

  eq(stored()["MEMORY.md"], HOST_BEFORE, "🔴 the `working` sibling in the same payload held the flush closed");
  eq((await memoryWrites(s.sessionId)).length, 0, "…and nothing was written");

  await fireResult(s, peek([{ taskId: "task_C2", status: "input_required" }]));
  eq(stored()["MEMORY.md"], HOST_BEFORE, "…and an input_required view keeps it closed — that child can still be released");

  await fireResult(s, peek([{ taskId: "task_C2", status: "completed" }]));
  eq(stored()["MEMORY.md"], EDIT, "…and the terminal view releases the guard and flushes");
}

console.log("4. a sync delegation return flushes the same way (the shipped path):");
{
  const s = makeSeat("seat-sync");
  await fireMemory(s, "session.started");
  const BEFORE = stored()["MEMORY.md"];
  const LEARNED = `${BEFORE}- a native subagent child wrote this into the parent's tree\n`;
  s.sandbox.childEdit("MEMORY.md", LEARNED);

  eq(stored()["MEMORY.md"], BEFORE, "NEGATIVE CONTROL: before the return, the store does not have it");

  await fireResult(s, syncResult("call_D"));

  eq(stored()["MEMORY.md"], LEARNED, "🔴 the sync return flushed the child's edit to the store inside the turn");
  const writes = await memoryWrites(s.sessionId);
  eq(writes.length, 1, "one memory.write row");
  eq((writes[0].detail as { outcome?: string }).outcome, "settled", '…stamped outcome:"settled" — ONE label for both edges, as the ticket asks');
  const rows = (await flushRows()).filter((r) => (r.detail as { edge?: string }).edge === "delegation-returned");
  ok(rows.length >= 1, "…and the row names the SYNC edge, so the two edges are distinguishable in the log");
  eq((rows[rows.length - 1].detail as { liveTasks?: number }).liveTasks, 0, "…with no live tasks — the guard is inert on the shipped sync path");
}

console.log("5. the session-end backstop after a settled flush writes nothing and self-conflicts nothing:");
{
  const s = makeSeat("seat-backstop");
  await fireMemory(s, "session.started");
  const EDIT = `${stored()["MEMORY.md"]}- a fact worth keeping\n`;
  s.sandbox.childEdit("MEMORY.md", EDIT);
  await fireResult(s, syncResult("call_E"));
  eq(stored()["MEMORY.md"], EDIT, "the settled flush landed the edit");
  eq((await memoryWrites(s.sessionId)).length, 1, "one row so far");

  await fireMemory(s, "session.completed");
  eq((await memoryWrites(s.sessionId)).length, 1, "the backstop changes nothing, so it emits NO second memory.write row");
  eq(conflictSiblings(), [], "🔴 BASELINE ADVANCE: the backstop does not mint a .conflict- sibling from the session's own settled write");
  eq(stored()["MEMORY.md"], EDIT, "…and the store still holds exactly the flushed content");

  const s2 = makeSeat("seat-backstop-2");
  await fireMemory(s2, "session.started");
  const FIRST = `${stored()["MEMORY.md"]}- first\n`;
  s2.sandbox.childEdit("MEMORY.md", FIRST);
  await fireResult(s2, syncResult("call_F"));
  const SECOND = `${FIRST}- second, written after the delegation came back\n`;
  s2.sandbox.childEdit("MEMORY.md", SECOND);
  await fireMemory(s2, "session.completed");
  eq(stored()["MEMORY.md"], SECOND, "a post-settlement edit still lands at session end");
  eq(conflictSiblings(), [], "…with NO .conflict- sibling");
  eq((await memoryWrites(s2.sessionId)).map((r) => (r.detail as { outcome?: string }).outcome).sort(), ["completed", "settled"], "…two real changes, each labelled by the flush point that ran it");
}

console.log("6. a dispatch receipt flushes nothing:");
{
  const s = makeSeat("seat-dispatch");
  await fireMemory(s, "session.started");
  const BEFORE = stored()["MEMORY.md"];
  s.sandbox.childEdit("MEMORY.md", `${BEFORE}- an edit that must NOT be flushed at dispatch\n`);

  await fireResult(s, receipt("task_G", "call_G"));

  eq(stored()["MEMORY.md"], BEFORE, "the dispatch edge wrote nothing to the store");
  eq((await memoryWrites(s.sessionId)).length, 0, "…and emitted no memory.write row");
  await fireResult(s, syncResult("call_G2"));
  eq(stored()["MEMORY.md"], BEFORE, "…and the dispatched task counts LIVE: a later sync return is held closed by the guard");
}

console.log(`\n✓ settlement-flush: ${n} assertions passed (a terminal task view and a sync delegation return each persist the parent's tree with outcome:"settled"; the fan-out guard skips — and audits the skip — while any delegated task is non-terminal, including one seen only as a working/input_required view; a dispatch receipt flushes nothing; the session-end backstop stays a silent, conflict-free no-op)\n`);
