import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-settlement-flush-")), "ops.sqlite3");
delete process.env.OE_ORG;

import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import memoryHook from "../agent/hooks/memory.js";
import spawnTaintHook from "../agent/hooks/spawn-taint.js";
import { conflictName } from "../agent/hooks/memory.js";
import { MAX_FLUSH_HOLDS, SETTLEMENT_FLUSH_ACTION, liveTaskIds, noteTaskDispatched, noteTaskViews } from "../agent/hooks/settlement-flush.js";
import { adoptTaskTaint } from "../agent/hooks/spawn-taint.js";
import { installTaskWake } from "../agent/channels/task-wake.js";
import { pendingDelegationOwing } from "../agent/access/pending-delegation-signal.js";
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

function makeChild(parent: Seat, index: number): Seat {
  const sessionId = `${parent.sessionId}-child-${index}`;
  const ctx = {
    agent: { name: "test" },
    channel: { kind: "subagent", continuationToken: `subagent:${parent.sessionId}:call_${index}` },
    getSandbox: async () => parent.sandbox,
    session: {
      id: sessionId,
      parent: { sessionId: parent.sessionId, callId: `call_${index}`, rootSessionId: parent.sessionId, turn: { id: `${parent.sessionId}-turn-1`, sequence: 1 } },
      turn: { id: `${sessionId}-turn-1`, sequence: 1 },
      auth: {
        current: {
          principalId: "U7",
          principalType: "slack-user",
          attributes: { ...SLACK_ATTRS, oe_platform: "slack", oe_grain: "standing", oe_window_token: WINDOW },
        },
      },
    },
  } as unknown as HookContext;
  return { sessionId, sandbox: parent.sandbox, als: new FakeEveContext(), ctx };
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

async function fireTurnEnd(s: Seat): Promise<void> {
  await inSession(s, async () => {
    await taint.events["turn.completed"]({ type: "turn.completed" } as unknown as Parameters<(typeof taint.events)["turn.completed"]>[0], s.ctx);
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

function receiptV2(taskId: string, callId: string): unknown {
  return { kind: "tool-result", toolName: "agent", callId, output: { agentId: `ag_${callId}`, status: "working", taskId } };
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
  await new Promise((r) => setTimeout(r, 20));
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
  eq((rows[rows.length - 1].detail as { liveTaskIds?: string[] }).liveTaskIds, undefined, "…and NO liveTaskIds — nothing held the tree, so there is nothing to name");
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
  const skipIds = (skips[skips.length - 1].detail as { liveTaskIds?: string[] }).liveTaskIds;
  eq(JSON.stringify(skipIds), JSON.stringify(["task_B2"]), "…and NAMING it — the still-writing sibling is the one holding the tree");
  eq((skipIds ?? []).includes("task_B1"), false, "…while the task this peek settled is GONE from the list");

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

console.log("6B. an eve 0.43.0+ dispatch receipt flushes nothing, and arms the guard:");
{
  const s = makeSeat("seat-dispatch-v2");
  await fireMemory(s, "session.started");
  const BEFORE = stored()["MEMORY.md"];
  s.sandbox.childEdit("MEMORY.md", `${BEFORE}- an edit that must NOT be flushed at dispatch\n`);

  await fireResult(s, receiptV2("task_G943", "call_G943"));

  eq(stored()["MEMORY.md"], BEFORE, "🔴 P6B: the ENVELOPE B dispatch edge wrote nothing to the store — it took BRANCH 1, not the sync BRANCH 3 that flushes");
  eq((await memoryWrites(s.sessionId)).length, 0, "…and emitted no memory.write row");
  await fireResult(s, syncResult("call_G943b"));
  eq(stored()["MEMORY.md"], BEFORE, "🔴 P6B: …and the ENVELOPE B task counts LIVE in the fan-out guard: a later sync return is held closed. This is the OPE-592 arming that was OFF on eve 0.43.0+");
}

console.log("7. N concurrent children hold ONE tree and the parent stays its only writer:");
{
  const s = makeSeat("seat-fanout-n");
  await fireMemory(s, "session.started");
  const BEFORE = stored()["MEMORY.md"] as string;

  const children = [1, 2, 3].map((i) => makeChild(s, i));
  eq(new Set(children.map((c) => c.sessionId)).size, 3, "harness: three DISTINCT child sessions");
  ok(
    children.every((c) => c.sandbox === s.sandbox),
    "harness: all three children hold the PARENT's sandbox object — one inherited key, one filesystem",
  );

  const CHILD_1 = `${BEFORE}- child 1 wrote this\n`;
  const CHILD_2 = `${BEFORE}- child 2 wrote this, over child 1\n`;
  const CHILD_3 = "child 3 kept to its own file\n";
  s.sandbox.childEdit("MEMORY.md", CHILD_1);
  s.sandbox.childEdit("MEMORY.md", CHILD_2);
  s.sandbox.childEdit("notes/child-3.md", CHILD_3);
  eq(s.sandbox.read("MEMORY.md"), CHILD_2, "the contested path holds the LAST writer's bytes — child 1's write is already lost inside the shared tree");

  for (const c of children) {
    await inSession(c, async () => {
      await memory.events["session.started"]({ type: "session.started" }, c.ctx);
    });
  }
  eq(
    s.sandbox.read("MEMORY.md"),
    CHILD_2,
    "🔴 THREE children each ran session.started and NONE re-pulled the silo — a re-pull writes the store's OLDER bytes over the parent's live working copy, mid-turn, once per child",
  );
  eq(s.sandbox.read("notes/child-3.md"), CHILD_3, "…and the scoped file survives every one of them too");

  for (const c of children) {
    await inSession(c, async () => {
      await memory.events["session.completed"]({ type: "session.completed" }, c.ctx);
    });
  }
  eq(stored()["MEMORY.md"], BEFORE, "🔴 THE SINGLE-WRITER RULE AT N: three children ran BOTH hook halves and the store is untouched");
  ok(stored()["notes/child-3.md"] === undefined, "…and no child's new file reached the store either");
  for (const c of children) {
    eq((await memoryWrites(c.sessionId)).length, 0, `…and child ${c.sessionId} emitted NO memory.write row of its own`);
  }
  eq(conflictSiblings(), [], "…so no child minted a .conflict- sibling of the parent's in-flight edits");

  await fireResult(s, syncResult("call_H"));
  eq(stored()["MEMORY.md"], CHILD_2, "🔴 the PARENT's flush is what carries the children's work to the store");
  eq(stored()["notes/child-3.md"], CHILD_3, "…including the child that kept to its own file scope — nothing it wrote was lost");
  eq(stored()["MEMORY.md"]?.includes("child 1 wrote this"), false, "🔴 AND CHILD 1's WRITE IS GONE. Nothing recovers it: the loss happened in the shared filesystem, before any flush could see it. This is why the mitigation is a non-overlapping write scope in the brief and not machinery here");
  const writes = await memoryWrites(s.sessionId);
  eq(writes.length, 1, "exactly ONE memory.write row for the whole fan-out — one owner, one write");
}

console.log("8. a dispatched task the seat never peeks releases the tree after a bounded number of held attempts:");
{
  const s = makeSeat("seat-wedge");
  await fireMemory(s, "session.started");
  const BEFORE = stored()["MEMORY.md"] as string;

  await fireResult(s, receipt("task_W1", "call_W1"));
  await fireResult(s, receipt("task_W2", "call_W2"));
  const EDIT = `${BEFORE}- the worker's note, which must reach the store\n`;
  s.sandbox.childEdit("MEMORY.md", EDIT);

  await fireResult(s, peek([{ taskId: "task_W1", status: "completed" }]));
  eq(stored()["MEMORY.md"], BEFORE, "attempt 1: the un-peeked sibling holds the flush closed — this much is the guard working as designed");
  const first = (await flushRows()).filter((r) => (r.detail as { outcome?: string }).outcome === "skipped");
  eq(
    JSON.stringify((first[0].detail as { liveTaskIds?: string[] }).liveTaskIds),
    JSON.stringify(["task_W2"]),
    "…and the skip names the task the peek did not carry",
  );

  for (let attempt = 2; attempt <= MAX_FLUSH_HOLDS; attempt++) {
    await fireTurnEnd(s);
    eq(stored()["MEMORY.md"], BEFORE, `attempt ${attempt}: still held — the bound is not spent yet`);
  }

  await fireTurnEnd(s);
  eq(stored()["MEMORY.md"], EDIT, "🔴 OPE-724: the parent's tree REACHES THE STORE even though the seat never peeked the second task");
  const writes = await memoryWrites(s.sessionId);
  eq(writes.length, 1, "…in exactly one memory.write row");
  eq((writes[0].detail as { outcome?: string }).outcome, "settled", "…stamped settled, like every other flush on this edge");

  const retiring = (await flushRows()).filter((r) => Array.isArray((r.detail as { retiredTaskIds?: string[] }).retiredTaskIds));
  eq(retiring.length, 1, "exactly ONE audit row records a retirement — the moment the guard stopped protecting that task");
  eq(
    JSON.stringify((retiring[0].detail as { retiredTaskIds?: string[] }).retiredTaskIds),
    JSON.stringify(["task_W2"]),
    "…naming the retired id, so a reader can tell WHICH child the next flush ran without",
  );

  await inSession(s, async () => {
    eq((liveTaskIds() as string[]).includes("task_W2"), false, "NEGATIVE CONTROL: the retired id no longer holds the tree");
  });

  const AFTER = `${EDIT}- a second note\n`;
  s.sandbox.childEdit("MEMORY.md", AFTER);
  await fireResult(s, receipt("task_W3", "call_W3"));
  await fireTurnEnd(s);
  eq(stored()["MEMORY.md"], EDIT, "🔴 NEGATIVE CONTROL: a fresh dispatch closes the guard again — the bound retires evidence, it does not remove the guard");
}

console.log("9. the OPE-719 discriminator — the delete survives the awaits, and a second dispatch reproduces the wedge:");
{
  const s = makeSeat("seat-lost-delete");
  await inSession(s, async () => {
    noteTaskDispatched("task_R");
    eq(liveTaskIds() as string[], ["task_R"], "harness: the dispatch armed the guard");

    noteTaskViews([{ taskId: "task_R", status: "completed", agentId: "ag_task_R" }]);
    eq(liveTaskIds() as string[], [], "the terminal view deleted the id");

    const installed = await installTaskWake({
      org: ORG,
      taskId: "task_R",
      status: "completed",
      sessionId: s.sessionId,
      turnId: (s.ctx as unknown as { session: { turn: { id: string } } }).session.turn.id,
      inheritedWakeId: undefined,
    });
    ok(installed.outcome.length > 0, "harness: installTaskWake really ran between the delete and the read");
    await adoptTaskTaint({ taskId: "task_R", status: "completed", agentId: "ag_task_R" }, s.sessionId);

    eq(liveTaskIds() as string[], [], "🔴 (b) REFUTED: the delete SURVIVES both awaits — one container, mutated in place, read back by the same handler");
  });

  const s2 = makeSeat("seat-lost-delete-control");
  await inSession(s2, async () => {
    noteTaskDispatched("task_S");
    noteTaskViews([{ taskId: "task_S", status: "working", agentId: "ag_task_S" }]);
    await installTaskWake({
      org: ORG,
      taskId: "task_S",
      status: "working",
      sessionId: s2.sessionId,
      turnId: (s2.ctx as unknown as { session: { turn: { id: string } } }).session.turn.id,
      inheritedWakeId: undefined,
    });
    await adoptTaskTaint({ taskId: "task_S", status: "working", agentId: "ag_task_S" }, s2.sessionId);
    eq(liveTaskIds() as string[], ["task_S"], "NEGATIVE CONTROL: a working view is STILL there after the same two awaits");
  });

  const s3 = makeSeat("seat-second-dispatch");
  await fireMemory(s3, "session.started");
  const BEFORE3 = stored()["MEMORY.md"] as string;
  const TURN3 = (s3.ctx as unknown as { session: { turn: { id: string } } }).session.turn.id;
  s3.sandbox.childEdit("MEMORY.md", `${BEFORE3}- an edit the wedge would strand\n`);

  await fireResult(s3, receipt("task_T1", "call_T1"));
  await inSession(s3, async () => {
    eq(pendingDelegationOwing(TURN3, "wake-x", undefined), "task_T1", "harness: the first dispatch is on the ledger for this turn");
  });

  await fireResult(s3, receipt("task_T2", "call_T2"));
  await fireResult(s3, peek([{ taskId: "task_T1", status: "completed" }]));

  eq(stored()["MEMORY.md"], BEFORE3, "the settlement SKIPPED — the store is untouched, as the red run's was");
  const skips3 = (await flushRows()).filter((r) => (r.detail as { outcome?: string }).outcome === "skipped");
  const last3 = skips3[0].detail as { liveTasks?: number; liveTaskIds?: string[] };
  eq(last3.liveTasks, 1, "🔴 SIGNAL 1 REPRODUCED: `SKIPPED — 1` on a settlement whose peek carried the only task the seat had peeked");
  eq(JSON.stringify(last3.liveTaskIds), JSON.stringify(["task_T2"]), "…and the id is the SECOND dispatch, not the peeked one — which is the whole diagnosis");
  eq((last3.liveTaskIds ?? []).includes("task_T1"), false, "…the peeked id is absent, so the delete ran");
  await inSession(s3, async () => {
    eq(pendingDelegationOwing(TURN3, "wake-x", undefined), "task_T2", "🔴 SIGNAL 2 REPRODUCED: the OPE-701 ledger still owes on the SETTLEMENT turn — only a dispatch on that turn can stamp it");
  });

  const s4 = makeSeat("seat-single-dispatch");
  await fireMemory(s4, "session.started");
  const BEFORE4 = stored()["MEMORY.md"] as string;
  const TURN4 = (s4.ctx as unknown as { session: { turn: { id: string } } }).session.turn.id;
  const EDIT4 = `${BEFORE4}- the single worker's note\n`;
  s4.sandbox.childEdit("MEMORY.md", EDIT4);
  await fireResult(s4, receipt("task_U1", "call_U1"));
  await fireResult(s4, peek([{ taskId: "task_U1", status: "completed" }]));
  eq(stored()["MEMORY.md"], EDIT4, "CONTROL: with ONE dispatch the settlement FLUSHES — the wedge needs the second id");
  await inSession(s4, async () => {
    eq(pendingDelegationOwing(TURN4, "wake-x", undefined), undefined, "CONTROL: …and the ledger owes NOTHING, so the red run's second signal is not a property of every settlement");
  });
}

interface EveActionResultEvent {
  readonly type: string;
  readonly data: { readonly result: unknown };
}

interface EveCoordination {
  setPendingCoordinationBatch(input: {
    readonly runtimeActions: readonly unknown[];
    readonly tasks: readonly unknown[];
    readonly event: { readonly sequence: number; readonly stepIndex: number; readonly turnId: string };
    readonly responseMessages: readonly unknown[];
    readonly session: unknown;
  }): unknown;
  resolvePendingCoordination(input: {
    readonly emit: (event: EveActionResultEvent) => Promise<void>;
    readonly session: unknown;
    readonly stepInput: { readonly runtimeActionResults: readonly unknown[] };
  }): Promise<{ readonly outcome: string }>;
}

console.log("10. the blocking arm's batch rule — a partial dispatch batch emits NO action.result (OPE-621):");
{
  const require = createRequire(import.meta.url);
  const eveRoot = dirname(require.resolve("eve/package.json"));
  const evePath = (rel: string) => pathToFileURL(join(eveRoot, "dist/src", rel)).href;
  const coordination = (await import(evePath("harness/coordination.js"))) as EveCoordination;
  const { AGENT_HANDLES_STATE_KEY } = (await import(evePath("subagents/handles/state-key.js"))) as { AGENT_HANDLES_STATE_KEY: string };

  const NAME = "worker";
  const call = (id: string): unknown => ({
    callId: id,
    description: "delegate",
    input: {},
    toolName: NAME,
    target: { kind: "subagent-call", nodeId: "node", subagentName: NAME },
  });
  const handle = (id: string): unknown => ({
    phase: "running",
    identity: { id: `ag_${NAME}:${id}`, name: NAME, nodeId: "node" },
    operation: { kind: "start", id: `op_${id}`, callId: id, parentTurnId: "turn_1" },
    address: { kind: "agent/local", sessionId: `child_${id}`, continuationToken: `tok_${id}` },
  });
  const childResult = (id: string, output: string): unknown => ({
    kind: "subagent-result",
    origin: "child",
    callId: id,
    subagentName: NAME,
    output,
    outcome: { kind: "terminal", result: { kind: "succeeded", output }, usageDelta: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 0, outputTokens: 0 } },
  });

  const parked = coordination.setPendingCoordinationBatch({
    runtimeActions: [call("call_A"), call("call_B")],
    tasks: [],
    event: { sequence: 3, stepIndex: 0, turnId: "turn_1" },
    responseMessages: [{ role: "assistant", content: [] }],
    session: { sessionId: "parent-seat", history: [], state: { [AGENT_HANDLES_STATE_KEY]: { handles: [handle("call_A"), handle("call_B")] } } },
  });

  async function resolveWith(results: readonly unknown[]): Promise<{ outcome: string; events: EveActionResultEvent[] }> {
    const events: EveActionResultEvent[] = [];
    const out = await coordination.resolvePendingCoordination({
      emit: async (e) => {
        events.push(e);
      },
      session: parked,
      stepInput: { runtimeActionResults: results },
    });
    return { outcome: out.outcome, events };
  }

  const partial = await resolveWith([childResult("call_A", "A answered")]);
  eq(partial.outcome, "unresolved", "🔴 ONE of two children back ⇒ eve leaves the batch UNRESOLVED — the parent's turn stays parked");
  eq(
    partial.events.filter((e) => e.type === "action.result").length,
    0,
    "🔴 …and emits NO action.result at all, so BRANCH 3's flush never runs while child B holds the tree",
  );

  const full = await resolveWith([childResult("call_A", "A answered"), childResult("call_B", "B answered")]);
  eq(full.outcome, "resolved", "NEGATIVE CONTROL: with BOTH children back the batch resolves");
  const emitted = full.events.filter((e) => e.type === "action.result").map((e) => e.data.result as { callId: string });
  eq(
    emitted.map((r) => r.callId),
    ["call_A", "call_B"],
    "NEGATIVE CONTROL: …and BOTH action.result rows are emitted, in pending-key order",
  );

  const s5 = makeSeat("seat-blocking-fanout");
  await fireMemory(s5, "session.started");
  const BEFORE5 = stored()["MEMORY.md"] as string;
  const EDIT5 = `${BEFORE5}- both blocking workers wrote before either result arrived\n`;
  s5.sandbox.childEdit("MEMORY.md", EDIT5);
  await fireResult(s5, emitted[0]);
  eq(stored()["MEMORY.md"], EDIT5, "the FIRST eve-emitted sync result flushes the shared tree — no sibling can still be writing it");
  await fireResult(s5, emitted[1]);
  eq(stored()["MEMORY.md"], EDIT5, "…and the second is a diff-based no-op, exactly as P5 pins for the settlement label");
}

console.log(`\n✓ settlement-flush: ${n} assertions passed (a terminal task view and a sync delegation return each persist the parent's tree with outcome:"settled"; the fan-out guard skips — and audits the skip — while any delegated task is non-terminal, including one seen only as a working/input_required view; a dispatch receipt flushes nothing; the session-end backstop stays a silent, conflict-free no-op; N concurrent children share ONE tree with the parent as its only writer; a task the seat never peeks releases the tree after a bounded number of held attempts; the OPE-719 second live id is a SECOND DISPATCH, not a lost delete; and the installed eve emits no action.result until every child of a dispatch batch has returned, which is why the blocking arm needs no guard)\n`);
