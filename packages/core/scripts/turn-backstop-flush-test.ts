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

{
  const { allowedOnWorkerSeat } = await import("../agent/access/worker-seat.js");
  ok(allowedOnWorkerSeat("ask_question"), "precondition: a delegated worker holds `ask_question`, so a task really can park at input_required");

  ok(TERMINAL_TASK_STATUSES.includes("input_required") === false, "🔴 negative control: `input_required` is NOT terminal — a question parks a task, it does not end it");

  const before = (await flushEdges()).filter((e) => e === "turn-backstop").length;
  const container = new FakeEveContext();

  await inEveContext(container, async () => {
    noteTaskDispatched("task-asked");
    noteTaskViews([{ taskId: "task-asked", status: "input_required" }] as never);
    ok(liveTaskCount() === 1, "asked: an input_required view ARMS the live set — the worker is parked, not finished");
    const held = await flushDirtyTreeAtTurnEnd(seatCtx);
    ok(held !== null && held.outcome === "skipped", "asked: the backstop is HELD CLOSED while a worker waits on a human answer");
    ok(held!.live === 1, "asked: …and the skip records the parked worker as the reason");
  });

  {
    const resumed = new FakeEveContext();
    await inEveContext(resumed, async () => {
      ok(liveTaskCount() === 0, "resumed: a session that never saw the dispatch starts with an empty live set");
      noteTaskViews([{ taskId: "task-asked", status: "input_required" }] as never);
      ok(liveTaskCount() === 1, "🔴 resumed: a parked view ARMS the guard on its own — a non-terminal sighting is first-hand proof the worker still holds the tree");
      const held = await flushSettledMemory(seatCtx, "task-settled");
      ok(held.outcome === "skipped" && held.live === 1, "🔴 resumed: so the settlement edge is HELD by the parked worker, with no dispatch of its own to lean on");
    });
    await inEveContext(resumed, async () => {
      noteTaskViews([{ taskId: "task-asked", status: TERMINAL_TASK_STATUSES[0]! }] as never);
      const ran = await flushSettledMemory(seatCtx, "task-settled");
      ok(ran.outcome === "flushed", "resumed control: the same edge flushes once the task settles — the skip above was the parked status, not a dead path");
    });
  }

  await inEveContext(container, async () => {
    noteTaskViews([{ taskId: "task-asked", status: "input_required" }] as never);
    const stillHeld = await flushDirtyTreeAtTurnEnd(seatCtx);
    ok(stillHeld !== null && stillHeld.outcome === "skipped", "waiting: a LATER turn is held too — the wait does not time out into a flush behind the worker's back");
    ok(stillHeld!.live === 1, "waiting: …still on the same one parked worker");
  });

  await settle();
  ok((await flushEdges()).filter((e) => e === "turn-backstop").length - before === 2, "held: both held attempts are AUDITED — a store left stale while a question is open is visible to an operator");

  await inEveContext(container, async () => {
    noteTaskViews([{ taskId: "task-asked", status: TERMINAL_TASK_STATUSES[0]! }] as never);
    ok(liveTaskCount() === 0, "answered: the settled task leaves the live set");
    const flushed = await flushDirtyTreeAtTurnEnd(seatCtx);
    ok(flushed !== null && flushed.outcome === "flushed", "answered: the SAME call now PERSISTS — the hold ends when the question does, it is not a permanent block");
    ok(treeIsDirty() === false, "answered: …and the flush clears the dirty flag");
  });
  await settle();
  ok((await flushEdges()).filter((e) => e === "turn-backstop").length - before === 3, "answered: the persist is audited under the same edge label as the holds that preceded it");
}

{
  const container = new FakeEveContext();
  const before = (await flushEdges()).filter((e) => e === "turn-backstop").length;
  const { MAX_FLUSH_HOLDS, noteTaskSettled } = await import("../agent/hooks/settlement-flush.js");

  await inEveContext(container, async () => {
    noteTaskDispatched("task-note");
    ok(liveTaskCount() === 1, "notification: the dispatch arms the guard, exactly as the view path does");
    ok(treeIsDirty() === true, "notification: …and marks the tree dirty");

    for (let i = 0; i < MAX_FLUSH_HOLDS; i++) {
      const held = await flushDirtyTreeAtTurnEnd(seatCtx);
      ok(held !== null && held.outcome === "skipped", `notification: held attempt ${i + 1} of ${MAX_FLUSH_HOLDS} is SKIPPED while the child holds the tree`);
    }
    ok(liveTaskCount() === 0, "notification: the last hold RETIRES the id (OPE-724) — the guard stops protecting a child it has waited long enough for");

    const cleared = await flushDirtyTreeAtTurnEnd(seatCtx);
    ok(cleared !== null && cleared.outcome === "flushed", "notification: the next turn end therefore PERSISTS");
    ok(
      treeIsDirty() === false,
      "🔴 notification PRECONDITION: the tree now reads CLEAN — asserted `=== false` — while the child is STILL RUNNING and still writing. This is the state the settlement has to repair",
    );

    noteTaskSettled({ taskId: "task-note", status: TERMINAL_TASK_STATUSES[0]!, agentId: null });
    ok(
      treeIsDirty() === true,
      "🔴 notification: `noteTaskSettled` RE-MARKS the tree dirty — asserted `=== true`. Delete that half and the backstop below returns null, and everything the child wrote after the retirement flush is lost at the next rotation",
    );
    const r = await flushDirtyTreeAtTurnEnd(seatCtx);
    ok(r !== null && r.outcome === "flushed", "🔴 notification END TO END: the turn the notification arrived on PERSISTS the child's final edits — no `task_peek`, no `task_cancel`, no tool call at all");
  });
  await settle();
  ok((await flushEdges()).filter((e) => e === "turn-backstop").length - before === MAX_FLUSH_HOLDS + 2, "notification: every attempt is audited — the holds, the retirement flush and the settlement flush");
}

{
  const container = new FakeEveContext();
  const { noteTaskSettled } = await import("../agent/hooks/settlement-flush.js");
  await inEveContext(container, async () => {
    noteTaskDispatched("task-sib-a");
    noteTaskDispatched("task-sib-b");
    ok(liveTaskCount() === 2, "siblings: two background children hold the tree");
    noteTaskSettled({ taskId: "task-sib-a", status: TERMINAL_TASK_STATUSES[0]!, agentId: null });
    ok(liveTaskCount() === 1, "🔴 siblings: a settlement notification drops ITS id and only its id — asserted `=== 1`, so the guard still holds for the sibling that is mid-write");
    const held = await flushDirtyTreeAtTurnEnd(seatCtx);
    ok(held !== null && held.outcome === "skipped", "🔴 siblings NEGATIVE CONTROL: the flush is still HELD — one settlement does not open the guard for a child that never settled");
    noteTaskSettled({ taskId: "task-sib-b", status: TERMINAL_TASK_STATUSES[0]!, agentId: null });
    ok(liveTaskCount() === 0, "siblings: the second settlement empties the set");
    const flushed = await flushDirtyTreeAtTurnEnd(seatCtx);
    ok(flushed !== null && flushed.outcome === "flushed", "siblings: …and only then does the turn end persist");
  });
  await settle();
}

rmSync(tmp, { recursive: true, force: true });
console.log(`✓ turn-backstop-flush: ${passed} assertions passed`);
