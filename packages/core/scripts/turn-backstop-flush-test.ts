import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-turn-backstop-flush-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");
process.env.OE_ORG = "acme";

const { registerSlackFixtureMapper } = await import("./_slack-test-stubs.js");
registerSlackFixtureMapper();
await import("./_register-test-config.js");

const { FakeEveContext, inEveContext } = await import("./_eve-context-stub.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { TERMINAL_TASK_STATUSES } = await import("../agent/access/background-tasks.js");
const flush = await import("../agent/hooks/settlement-flush.js");
const { SETTLEMENT_FLUSH_ACTION, flushDirtyTreeAtTurnEnd, flushSettledMemory, noteTaskDispatched, noteTaskViews, treeIsDirty, liveTaskCount } = flush;

const ORG = "acme";

const seatCtx = {
  channel: { kind: "slack", continuationToken: "slack:sess-backstop" },
  session: {
    id: "sess-backstop",
    auth: { current: { principalId: "U7", principalType: "slack-user", attributes: { team_id: "T1", channel_id: "C1", channel_type: "channel" } } },
  },
} as never;

async function flushEdges(): Promise<string[]> {
  const rows = await readAudit({ org: ORG, action: SETTLEMENT_FLUSH_ACTION });
  return rows.map((r) => String(r.detail?.["edge"] ?? ""));
}

const settle = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 20));
};

{
  await inEveContext(new FakeEveContext(), async () => {
    ok(treeIsDirty() === false, "gate: a fresh session's tree is not dirty");
    const r = await flushDirtyTreeAtTurnEnd(seatCtx);
    ok(r === null, "gate: turn end on a session that never delegated returns null — no persist, no audit row, no sandbox read");
  });
  await settle();
  ok((await flushEdges()).length === 0, "gate: …and it writes NO audit row, so the cost of an idle turn is one boolean read");
}

{
  const container = new FakeEveContext();
  await inEveContext(container, async () => {
    noteTaskDispatched("task-alpha");
    ok(treeIsDirty() === true, "arm: dispatching a delegated task marks the parent's tree dirty");
    ok(liveTaskCount() === 1, "arm: …and counts it live, so the fan-out guard sees it");
  });

  await inEveContext(container, async () => {
    const held = await flushDirtyTreeAtTurnEnd(seatCtx);
    ok(held !== null && held.outcome === "skipped", "guard: the backstop is HELD CLOSED while the child still holds the tree — it inherits the torn-file guard, it does not bypass it");
    ok(held!.live === 1, "guard: the skip records WHY, so a reader can tell a held flush from an absent one");
  });
  await settle();
  ok((await flushEdges()).filter((e) => e === "turn-backstop").length === 1, "guard: the held attempt is still audited — a store left stale on purpose must be visible");

  await inEveContext(container, async () => {
    noteTaskViews([{ taskId: "task-alpha", status: TERMINAL_TASK_STATUSES[0]! }] as never);
    ok(liveTaskCount() === 0, "settle: a terminal view clears the live set");
    const r = await flushDirtyTreeAtTurnEnd(seatCtx);
    ok(r !== null && r.outcome === "flushed", "backstop: the next turn end PERSISTS — the parent that never peeked no longer waits for a session end that never comes");
    ok(treeIsDirty() === false, "backstop: …and the flush clears the dirty flag");
  });
  await settle();
  ok((await flushEdges()).filter((e) => e === "turn-backstop").length === 2, "backstop: the persist is audited under its own edge label, distinguishable from `task-settled`");
}

{
  const container = new FakeEveContext();
  await inEveContext(container, async () => {
    noteTaskDispatched("task-beta");
    noteTaskViews([{ taskId: "task-beta", status: TERMINAL_TASK_STATUSES[0]! }] as never);
    const first = await flushDirtyTreeAtTurnEnd(seatCtx);
    ok(first !== null && first.outcome === "flushed", "idempotence: the first turn end after a delegation flushes");

    const second = await flushDirtyTreeAtTurnEnd(seatCtx);
    ok(second === null, "idempotence: the SECOND turn end does nothing — one flush per delegation batch, not one per turn");
    const third = await flushDirtyTreeAtTurnEnd(seatCtx);
    ok(third === null, "idempotence: and the third, for as long as nothing new is delegated");

    noteTaskDispatched("task-gamma");
    noteTaskViews([{ taskId: "task-gamma", status: TERMINAL_TASK_STATUSES[0]! }] as never);
    const rearmed = await flushDirtyTreeAtTurnEnd(seatCtx);
    ok(rearmed !== null && rearmed.outcome === "flushed", "idempotence: a NEW delegation re-arms the backstop — the flag latches per batch, it is not spent once per session");
  });
}

{
  const container = new FakeEveContext();
  await inEveContext(container, async () => {
    noteTaskDispatched("task-delta");
    noteTaskViews([{ taskId: "task-delta", status: TERMINAL_TASK_STATUSES[0]! }] as never);
    const settled = await flushSettledMemory(seatCtx, "task-settled");
    ok(settled.outcome === "flushed", "settlement: the OPE-592 edge flushes exactly as before");
    ok(treeIsDirty() === false, "settlement: …and clears the dirty flag");
    ok((await flushDirtyTreeAtTurnEnd(seatCtx)) === null, "settlement: so the same turn's backstop is a no-op — a peeked delegation does not persist twice");
  });
}

{
  const container = new FakeEveContext();
  await inEveContext(container, async () => {
    ok((await flushDirtyTreeAtTurnEnd(seatCtx)) === null, "control: undirtied ⇒ null");
    noteTaskDispatched("task-epsilon");
    noteTaskViews([{ taskId: "task-epsilon", status: TERMINAL_TASK_STATUSES[0]! }] as never);
    const after = await flushDirtyTreeAtTurnEnd(seatCtx);
    ok(after !== null && after.outcome === "flushed", "control: the IDENTICAL call flushes once the flag is set — §1's absence is the gate, not a dead path");
  });
}

rmSync(tmp, { recursive: true, force: true });
console.log(`✓ turn-backstop-flush: ${passed} assertions passed`);
