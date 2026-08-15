import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-task-wake-identity-")), "ops.sqlite3");
process.env.OE_WORKSPACE = "dev";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (actual: unknown, expected: unknown, label: string) => {
  assert.deepStrictEqual(actual, expected, label);
  n++;
};

const require = createRequire(import.meta.url);
const eveRoot = dirname(require.resolve("eve/package.json"));
const { ContextContainer, contextStorage } = (await import(pathToFileURL(join(eveRoot, "dist/src/context/container.js")).href)) as {
  ContextContainer: new () => unknown;
  contextStorage: { run<T>(store: unknown, fn: () => T): T };
};

const __slackStubs = await import("./_slack-test-stubs.js");
__slackStubs.registerSlackFixtureCodec();

const { openTaskWake, installTaskWake, taskWakeId, taskWakeKey, TASK_WAKE_ACTION } = await import("../agent/channels/task-wake.js");
const { registerUnifiedWakeTarget, resolveUnifiedWakeTarget, resolveAnswerableReplyTarget } = await import("../agent/channels/unified-window.js");
const { currentWakeId, currentTurnId } = await import("../agent/identity/binding.js");
const { taskWakeThisTurn, noteTurnBoundary, uningressedTurn } = await import("../agent/access/task-wake-signal.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { readAudit } = await import("../agent/audit/audit.js");

const ORG = "default";
const WINDOW = "oe-dom:e2e:oe-sup:g1";
const SESSION = "sess-seat";

const ASK_THREAD = { platform: "slack", channelId: "C_ASK", threadTs: "111.1" } as const;
const OTHER_THREAD = { platform: "slack", channelId: "C_OTHER", threadTs: "222.2" } as const;

function seatCtx(wakeId: string | undefined, turnId: string) {
  return {
    channel: { kind: "unified", continuationToken: `unified:${WINDOW}` },
    session: {
      id: SESSION,
      turn: { id: turnId, sequence: 1 },
      auth: {
        current: {
          attributes: { oe_platform: "slack", oe_grain: "standing", oe_window_token: WINDOW, ...(wakeId === undefined ? {} : { oe_wake_id: wakeId }) },
          principalId: "U1",
          principalType: "slack-user",
        },
      },
    },
    agent: { name: "oe", nodeId: "__root__" },
  } as never;
}

const iso = () => new Date().toISOString();
const store = getOperationalStore();

const W_ASK = "wake-ask-0001";
await registerUnifiedWakeTarget(store, ORG, W_ASK, ASK_THREAD, iso(), WINDOW);

const minted = await openTaskWake({ org: ORG, taskId: "task_1", parentWakeId: W_ASK, windowToken: WINDOW });
ok(typeof minted === "string" && minted.length > 0, "P1: the dispatch edge MINTS a wake id for the parked task");
ok(minted !== W_ASK, "🔴 P1: the minted id is NOT the dispatching wake's id — a settlement that reused it would be the inherited-identity defect wearing a new name");
eq(await taskWakeId(ORG, "task_1"), minted, "P1: the taskId→wakeId row reads back, which is the join the settlement edge has (taskId is the only id on BOTH edges)");
eq(
  await resolveUnifiedWakeTarget(store, ORG, minted!),
  ASK_THREAD,
  "🔴 P1: the minted wake resolves to the DISPATCHING wake's origin — the conversation that asked for the work is where its answer is owed",
);
ok(taskWakeKey("task_1").startsWith("oe-task-wake:"), "P1: the row is namespaced apart from the taint plane's `oe-task-call:` / `oe-task-agent:` rows in the same slice");

eq(await openTaskWake({ org: ORG, taskId: "task_none", parentWakeId: undefined, windowToken: WINDOW }), null, "🔴 P2: NO dispatching wake ⇒ no identity is minted. A seat with no wake origin (an eval, a routine fire) has no conversation for the settlement to answer into either");
eq(await taskWakeId(ORG, "task_none"), undefined, "…and nothing is written, so the settlement reads `no-row` rather than a pointer to an address that resolves to nothing");
eq(await openTaskWake({ org: ORG, taskId: "task_ghost", parentWakeId: "wake-that-never-existed", windowToken: WINDOW }), null, "🔴 P2: an UNRESOLVABLE dispatching wake ⇒ no identity. The origin is COPIED, never guessed");
eq(await taskWakeId(ORG, "task_ghost"), undefined, "…and again nothing is written");

const W_LAST = "wake-last-0002";
await registerUnifiedWakeTarget(store, ORG, W_LAST, OTHER_THREAD, iso(), WINDOW);

await contextStorage.run(new ContextContainer(), async () => {
  noteTurnBoundary("turn_ask", W_ASK);
  eq(uningressedTurn("turn_ask"), false, "🔴 P8: a session's FIRST turn reads as INGRESSED — nothing to compare against, and the conservative answer installs nothing");
  noteTurnBoundary("turn_other", W_LAST);
  eq(uningressedTurn("turn_other"), false, "🔴 P8: a turn whose stamp CHANGED brought its own delivery — an OE ingress mints a new wake id every time, so a changed stamp is proof of one");

  const ctx = seatCtx(W_LAST, "turn_settle");
  noteTurnBoundary("turn_settle", W_LAST);
  eq(currentTurnId(ctx), "turn_settle", "precondition: the turn id is readable — the whole identity is scoped to it");
  eq(uningressedTurn("turn_settle"), true, "🔴 P8 THE DISCRIMINATOR: the stamp is BYTE-IDENTICAL to the previous turn's, so this turn brought no delivery of its own — the structural shape of a task wake, with no text parsed");

  eq(currentWakeId(ctx), W_LAST, "🔴 P4 THE MEASURED DEFECT: before the install, the task-woken turn answers with the PREVIOUS wake's id — a live address into a conversation that asked it nothing");
  eq(taskWakeThisTurn("turn_settle"), undefined, "…and the turn holds no adopted identity yet — asserted `=== undefined`, so P3's pass cannot come from a slot that was already set");

  const settled = await installTaskWake({ org: ORG, taskId: "task_1", status: "completed", sessionId: SESSION, turnId: "turn_settle", inheritedWakeId: W_LAST });
  eq(settled, { outcome: "installed", wakeId: minted }, "🔴 P3: the settlement edge names the turn with the TASK's own wake id");
  eq(currentWakeId(ctx), minted, "🔴 P3 THE FIX: `currentWakeId` now answers with the task's identity, NOT the inherited stamp — one change at the source, every reply route with it");
  eq(taskWakeThisTurn("turn_settle"), minted, "…and the per-turn slot holds it under this turn's id");

  const second = await installTaskWake({ org: ORG, taskId: "task_1", status: "completed", sessionId: SESSION, turnId: "turn_settle", inheritedWakeId: minted! });
  eq(second.outcome, "already", "P3: a second settlement in the same turn reports `already` rather than re-naming the turn");
  eq(currentWakeId(ctx), minted, "…and the identity is unchanged — first terminal view wins the turn");

  const laterCtx = seatCtx(W_LAST, "turn_later");
  eq(taskWakeThisTurn("turn_later"), undefined, "🔴 P5: the adopted identity is stamped with `turn_settle` and is NOT returned for `turn_later` — asserted `=== undefined`");
  eq(currentWakeId(laterCtx), W_LAST, "🔴 P5: so a LATER turn falls straight back to its own auth stamp. The durable slot cannot hand a stale address forward");
  eq(taskWakeThisTurn(undefined), undefined, "P5: an unreadable turn id answers `undefined` too — the honest degrade, never a guess");
});

await contextStorage.run(new ContextContainer(), async () => {
  const ctx = seatCtx(W_LAST, "turn_norow");
  noteTurnBoundary("turn_prev", W_LAST);
  noteTurnBoundary("turn_norow", W_LAST);
  const missed = await installTaskWake({ org: ORG, taskId: "task_unknown", status: "completed", sessionId: SESSION, turnId: "turn_norow", inheritedWakeId: W_LAST });
  eq(missed, { outcome: "no-row", wakeId: null }, "🔴 P3 MISS: a settlement whose wake row is gone installs NOTHING and reports it");
  eq(currentWakeId(ctx), W_LAST, "…and the turn keeps the inherited stamp — the pre-OPE-585 behaviour, degraded honestly rather than silently");
});

await contextStorage.run(new ContextContainer(), async () => {
  const W_HUMAN = "wake-human-0003";
  await registerUnifiedWakeTarget(store, ORG, W_HUMAN, OTHER_THREAD, iso(), WINDOW);
  noteTurnBoundary("turn_h1", W_LAST);
  noteTurnBoundary("turn_h2", W_HUMAN);
  const ctx = seatCtx(W_HUMAN, "turn_h2");
  eq(uningressedTurn("turn_h2"), false, "P8: the human's turn brought its own delivery");

  const blocked = await installTaskWake({ org: ORG, taskId: "task_1", status: "completed", sessionId: SESSION, turnId: "turn_h2", inheritedWakeId: W_HUMAN });
  eq(blocked, { outcome: "ingressed", wakeId: minted }, "🔴 P8 THE FENCE: the row IS found, and the install is REFUSED anyway — a terminal task view is not proof that a task woke the turn");
  eq(currentWakeId(ctx), W_HUMAN, "🔴 P8: so the human's turn keeps its OWN wake id — asserted `=== W_HUMAN`, not merely 'not the task's'. The answer goes to the room that asked the question");
  eq(taskWakeThisTurn("turn_h2"), undefined, "…and nothing was written to the slot at all");
});

{
  const noTurn = await installTaskWake({ org: ORG, taskId: "task_1", status: "completed", sessionId: SESSION, turnId: undefined, inheritedWakeId: W_LAST });
  eq(noTurn, { outcome: "no-turn", wakeId: minted }, "P3: an unreadable turn id yields `no-turn` — the row was found, but there is no turn to scope it to");
}

await new Promise((r) => setTimeout(r, 60));
{
  const rows = await readAudit({ org: ORG, action: TASK_WAKE_ACTION });
  eq(TASK_WAKE_ACTION, "unified.task_wake", "P6: the action key names the plane (`unified`) and the event (`task_wake`), so it joins to the other wake classes");
  ok(rows.length >= 4, `P6: every settlement writes a row, including the misses (saw ${rows.length})`);

  const installed = rows.find((r) => (r.detail as Record<string, unknown> | undefined)?.outcome === "installed");
  ok(installed !== undefined, "🔴 P6 THE ROW THIS TICKET EXISTS FOR: a turn woken by a task settlement now has a wake row of its own");
  const d = installed!.detail as Record<string, unknown>;
  eq(d.task, "task_1", "P6: it names the task");
  eq(d.wakeId, minted, "P6: …the wake id the turn answers under");
  eq(d.inheritedWakeId, W_LAST, "🔴 P6: …AND the stale id it would otherwise have replied under. The defect stays countable after the fix, not only before it");
  eq(d.sessionId, SESSION, "P6: …the seat session");
  eq(d.turnId, "turn_settle", "P6: …and the turn, which is what joins this row to the transcript");
  eq(installed!.platform, "unified", "P6: the row sits on the single-window plane with every other wake row");

  ok(
    rows.some((r) => (r.detail as Record<string, unknown> | undefined)?.outcome === "no-row"),
    "🔴 P6: a settlement that could NOT find its identity is audited too — that is exactly the turn still running on a stale address, so it must never be a silent fall-through",
  );
}

{
  const stale = await resolveAnswerableReplyTarget(store, ORG, W_LAST, WINDOW, "turn_settle", W_LAST);
  ok(stale.ok, "P7 precondition: the inherited wake DOES resolve — the defect is a wrong address, not a missing one");
  eq(stale.ok ? stale.origin : null, OTHER_THREAD, "🔴 P7 THE HARM: on the inherited identity the task's answer resolves to C_OTHER — the conversation that never asked for the work");

  const fixed = await resolveAnswerableReplyTarget(store, ORG, minted!, WINDOW, "turn_settle", minted!);
  ok(fixed.ok, "P7: the task's own wake is answerable");
  eq(fixed.ok ? fixed.via : null, "turn", "P7: …through arm 2, the fence's own fast path — no new arm, no widening of what a model may address");
  eq(fixed.ok ? fixed.origin : null, ASK_THREAD, "🔴 P7 THE FIX: the answer resolves to C_ASK, the thread that asked. This is adoption-plan risk 4, closed and asserted");

  const foreign = await resolveAnswerableReplyTarget(store, ORG, "wake-other-seat", "oe-dom:other:oe-sup:g1", "turn_x", minted!);
  eq(foreign.ok, false, "🔴 P7: a DIFFERENT window cannot answer this task's wake — the minted row carries the dispatching seat's window token, so arm 4's cross-domain fence refuses");
}

console.log(`task-wake-identity: ${n} assertions passed`);
