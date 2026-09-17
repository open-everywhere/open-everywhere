import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-task-wake-identity-")), "ops.sqlite3");
_setDeploymentIdentityForTest({ workspace: "dev" });

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
__slackStubs.registerSlackFixtureMapper();

const { openTaskWake, installTaskWake, taskWakeId, taskWakeKey, TASK_WAKE_ACTION } = await import("../agent/channels/task-wake.js");
const { registerUnifiedWakeTarget, resolveUnifiedWakeBinding, resolveUnifiedWakeTarget, resolveAnswerableReplyTarget } = await import("../agent/channels/unified-window.js");
const { bindFrom, channelPlatform, currentWakeId, currentTurnId, deliveryStampOf, inheritedWakeStampOf } = await import("../agent/identity/binding.js");
const { taskWakeThisTurn, noteTurnBoundary, uningressedTurn } = await import("../agent/access/task-wake-signal.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { readAudit } = await import("../agent/audit/audit.js");

const ORG = "default";
const WINDOW = "oe-dom:e2e:oe-sup:g1";
const SESSION = "sess-seat";

const ASK_THREAD = { platform: "slack", channelId: "C_ASK", threadTs: "111.1" } as const;
const OTHER_THREAD = { platform: "slack", channelId: "C_OTHER", threadTs: "222.2" } as const;

function seatCtx(wakeId: string | undefined, turnId: string, deliveryId?: string) {
  return {
    channel: { kind: "unified", continuationToken: `unified:${WINDOW}` },
    session: {
      id: SESSION,
      turn: { id: turnId, sequence: 1 },
      auth: {
        current: {
          attributes: {
            oe_platform: "slack",
            oe_grain: "standing",
            oe_window_token: WINDOW,
            ...(wakeId === undefined ? {} : { oe_wake_id: wakeId }),
            ...(deliveryId === undefined ? {} : { oe_delivery_id: deliveryId }),
          },
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

eq(await openTaskWake({ org: ORG, taskId: "task_none", parentWakeId: undefined, windowToken: WINDOW }), null, "🔴 P2: NO dispatching wake ⇒ no identity is minted. An eval or unattributed internal wake has no conversation for the settlement to answer into either");
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

  eq(inheritedWakeStampOf(ctx), W_LAST, "🔴 P4 THE MEASURED DEFECT: eve brought no auth, so the task-woken turn's RAW stamp is still the PREVIOUS wake's id");
  eq(await resolveUnifiedWakeTarget(store, ORG, W_LAST), OTHER_THREAD, "🔴 P4: …and that id RESOLVES — a live address into a conversation that asked it nothing, not a dead string");
  eq(taskWakeThisTurn("turn_settle"), undefined, "…and the turn holds no adopted identity yet — asserted `=== undefined`, so P3's pass cannot come from a slot that was already set");

  eq(currentWakeId(ctx), undefined, "🔴 P11 THE FIX: an uningressed turn that has adopted nothing answers `undefined` — asserted `=== undefined`, so it cannot pass on a falsy stale id");

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
  eq(inheritedWakeStampOf(ctx), W_LAST, "P11 precondition: the stale stamp is still on the bag, so the next line is a fix and not an empty bag");
  eq(
    currentWakeId(ctx),
    undefined,
    "🔴 P11: a settlement that could NOT find its identity stays ADDRESSLESS — asserted `=== undefined`. This is the one case `task_peek` cannot repair, so silence is the only honest outcome and the `no-row` audit row is where it is counted",
  );
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

{
  const spawnTaint = await import("../agent/hooks/spawn-taint.js");
  const { addressedWakeThisTurn, claimTasksForAddressedWake, exactDispatchWakeThisTurn, noteTaskDispatchedThisTurn, recordDeliveredWakes } = await import("../agent/access/dispatch-origin-signal.js");
  const { recordRequesterIdentity, requesterThisTurn } = await import("../agent/access/requester-identity.js");
  const { OE_CHAT_NONMEMBER_ATTR } = await import("../agent/access/taint-signal.js");
  const { retargetTaskWakes, TASK_WAKE_RETARGET_ACTION } = await import("../agent/channels/task-wake.js");
  const handlers = (spawnTaint.default as unknown as { events: Record<string, (e: unknown, c: unknown) => Promise<void> | void> }).events;
  const handler = handlers["action.result"]!;
  const requested = handlers["actions.requested"]!;

  const receiptResult = (callId: string, taskId: string) => ({
    backgroundTask: { status: "working", taskId },
    callId,
    kind: "subagent-result",
    origin: "child",
    outcome: { kind: "parked", result: { kind: "succeeded", output: `Delegated as background task ${taskId} (working).` }, usageDelta: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 0, outputTokens: 0 } },
    output: { agentId: "ag_agent:6666", status: "working", taskId },
    subagentName: "agent",
  });

  const receiptResultV2 = (callId: string, taskId: string) => ({
    callId,
    kind: "tool-result",
    toolName: "agent",
    output: { agentId: "ag_agent:6666", status: "working", taskId },
  });

  const THREAD_P = { platform: "slack", channelId: "C_P", threadTs: "333.3" } as const;
  const BINDING_P = {
    org: ORG,
    platform: "slack",
    workspace: "T1",
    surface: "C_P",
    mode: "channel",
    visibility: "public",
    trust: "internal",
    principalId: "U_P",
    target: { channelId: "C_P" },
    threadTs: "333.3",
  } as const;
  const BINDING_DECISION = {
    org: ORG,
    platform: "slack",
    workspace: "T1",
    surface: "C_OTHER",
    mode: "channel",
    visibility: "public",
    trust: "internal",
    principalId: "U_OTHER",
    target: { channelId: "C_OTHER" },
    threadTs: "222.2",
  } as const;
  const W_P = "wake-p-0601";
  const W_DECISION = "wake-decision-0601";
  const AUTHORITY_P = { binding: BINDING_P, requester: { kind: "requester", principalId: "U_P" } as const, nonMemberWake: false };
  const AUTHORITY_DECISION = { binding: BINDING_DECISION, requester: { kind: "requester", principalId: "U_OTHER" } as const, nonMemberWake: true };
  const wakeEnvelope = (wakeId: string, requester: string) =>
    `<wake wake-id="${wakeId}"><channel><message from="human" author-id="${requester}" trigger="true">request</message></channel></wake>`;
  await registerUnifiedWakeTarget(store, ORG, W_P, THREAD_P, iso(), WINDOW, undefined, undefined, "slack/T1/C_P", BINDING_P, AUTHORITY_P);
  await registerUnifiedWakeTarget(store, ORG, W_DECISION, OTHER_THREAD, iso(), WINDOW, undefined, undefined, "slack/T1/C_OTHER", BINDING_DECISION, AUTHORITY_DECISION);

  await contextStorage.run(new ContextContainer(), async () => {
    const ctx: any = seatCtx(W_DECISION, "turn_coalesced");
    ctx.session.auth.current.principalId = "U_OTHER";
    ctx.session.auth.current.attributes[OE_CHAT_NONMEMBER_ATTR] = "true";
    noteTurnBoundary("turn_coalesced", W_DECISION);
    const coalescedMessage = `${wakeEnvelope(W_P, "U_P")}\n${wakeEnvelope(W_DECISION, "U_OTHER")}`;
    recordDeliveredWakes("turn_coalesced", coalescedMessage);
    recordRequesterIdentity(ctx, "turn_coalesced", coalescedMessage);
    eq(currentWakeId(ctx), W_DECISION, "P9 precondition: the coalesced turn's own stamp is the LAST delivery's — the decision wake, whose origin is the OTHER thread");
    eq(addressedWakeThisTurn("turn_coalesced"), undefined, "P9 precondition: the turn has said nothing yet, so the dispatch edge has no address to prefer — asserted `=== undefined`");

    eq(exactDispatchWakeThisTurn("turn_coalesced"), undefined, "🔴 P14: two delivered wakes are ambiguous before the model names one");
    await assert.rejects(
      async () => await requested({ data: { actions: [{ kind: "subagent-call", callId: "call_ambiguous", subagentName: "agent" }] } }, ctx),
      /dispatch authority is missing or ambiguous/,
      "🔴 P14 PRE-LAUNCH FENCE: a coalesced turn cannot launch a child under the last wake while no exact addressed wake exists",
    );
    n++;

    eq(claimTasksForAddressedWake("turn_coalesced", W_P).length, 0, "P14: naming P before dispatch records the exact addressed wake without claiming work");
    await requested({ data: { actions: [{ kind: "subagent-call", callId: "call_601a", subagentName: "agent" }] } }, ctx);
    await handler({ data: { result: receiptResult("call_601a", "task_601a_valid") } }, ctx);
    const mintedA = await taskWakeId(ORG, "task_601a_valid");
    ok(typeof mintedA === "string" && mintedA.length > 0, "🔴 P9: the REAL hook handler minted a wake for the dispatched task — without this the assertions below would pass on a branch that never ran");
    eq(
      await resolveUnifiedWakeTarget(store, ORG, mintedA!),
      THREAD_P,
      "🔴 P14: the task is registered against the exact addressed wake, never the coalesced last wake",
    );
    eq(await resolveUnifiedWakeBinding(store, ORG, mintedA!), BINDING_P, "P14: the worker snapshot carries P's binding at first write");

    const settlementTarget = await resolveAnswerableReplyTarget(store, ORG, mintedA!, WINDOW, "turn_settle_601", mintedA!);
    ok(settlementTarget.ok, "P9: the moved wake is still answerable — the re-point re-stamps the window token, so the cross-domain fence is not broken by the move");
    eq(settlementTarget.ok ? settlementTarget.origin : null, THREAD_P, "🔴 P9 END TO END: the settlement reply resolves to thread P. The worker's answer lands where the work was asked for");

    eq(addressedWakeThisTurn("turn_coalesced"), W_P, "P9: the turn's addressed wake is recorded");
    eq(claimTasksForAddressedWake("turn_coalesced", W_DECISION).length, 0, "P9: a SECOND reply in the same turn claims NOTHING — otherwise the task's address would depend on the order the model finished talking");
    eq(await resolveUnifiedWakeTarget(store, ORG, mintedA!), THREAD_P, "…and the wake still points at P, asserted after the second claim rather than merely before it");

    await requested({ data: { actions: [{ kind: "subagent-call", callId: "call_601b", subagentName: "agent" }] } }, ctx);
    await handler({ data: { result: receiptResult("call_601b", "task_601b") } }, ctx);
    const mintedB = await taskWakeId(ORG, "task_601b");
    ok(typeof mintedB === "string" && mintedB.length > 0, "P10: the second dispatch minted its own wake");
    ok(mintedB !== mintedA, "P10: …a different one — two tasks never share an address");
    eq(
      await resolveUnifiedWakeTarget(store, ORG, mintedB!),
      THREAD_P,
      "🔴 P10: a task dispatched AFTER the turn addressed P is registered against P AT THE EDGE — `currentWakeId` is still the decision wake, so this can only come from the addressed-wake read in the hook",
    );
    eq(claimTasksForAddressedWake("turn_coalesced", W_P).length, 0, "P10: …and it is not in the ledger, so no re-point is owed for it");
  });

  await contextStorage.run(new ContextContainer(), async () => {
    const bindingBridge = await import("../agent/hooks/binding-bridge.js");
    const child: any = {
      channel: { kind: "subagent", continuationToken: `subagent:${SESSION}:call_601a` },
      session: {
        id: "sess-child-601a",
        parent: { sessionId: SESSION, callId: "call_601a", rootSessionId: SESSION },
        turn: { id: "turn_child_601a", sequence: 0 },
        auth: {
          current: {
            attributes: {
              oe_platform: "notion",
              workspace_id: "N_OTHER",
              page_id: "P_OTHER",
              discussion_id: "D_OTHER",
              oe_requester: "ADMIN_B",
            },
            principalId: "ADMIN_B",
            principalType: "notion-user",
          },
        },
      },
    };
    eq(bindFrom(child).platform, "subagent", "🔴 P14 FAIL-CLOSED ORDERING: before the opening hook, a delayed child has no platform authority — it cannot consume the launch-time sibling auth");
    eq(bindFrom(child).surface, "unresolved", "P14 ordering control: the unresolved child also names no real sibling surface");
    const started = (bindingBridge.default as unknown as { events: Record<string, (e: unknown, c: unknown) => Promise<void> | void> }).events["turn.started"]!;
    await started({ data: { turnId: "turn_child_601a", sequence: 0 } }, child);
    eq(bindFrom(child), BINDING_P, "🔴 P14 THE FIX: the REAL opening hook restores the dispatch wake's full binding before the worker runs");
    eq(channelPlatform(child), "slack", "🔴 P14 PLATFORM: direct platform reads use the same dispatch authority, never later Notion auth");
    recordRequesterIdentity(child, "turn_child_601a", "parent-authored worker brief");
    eq(requesterThisTurn("turn_child_601a"), { kind: "requester", principalId: "U_P" }, "🔴 P14 REQUESTER: the child authorizes as dispatch requester A, never later admin B");
    const laterChild = {
      ...child,
      session: { ...(child as { session: object }).session, turn: { id: "turn_child_later", sequence: 1 } },
    } as never;
    eq(bindFrom(laterChild), BINDING_P, "P14 approval-resume parity: a later framework turn in the same dedicated child session keeps the dispatch authority; stale launch auth never reappears");
  });

  await contextStorage.run(new ContextContainer(), async () => {
    const ctx = seatCtx(W_DECISION, "turn_settlement_redelegate") as any;
    ctx.session.auth.current.attributes["oe_chat_nonmember"] = "true";
    ctx.session.auth.current.attributes["oe_requester"] = "ADMIN_B";

    noteTurnBoundary("turn_before_settlement_redelegate", W_DECISION);
    noteTurnBoundary("turn_settlement_redelegate", W_DECISION);
    await spawnTaint.settleFromTaskNotification(
      "Background task task_601a_valid (agent) is completed. Use task_peek to read its output.",
      SESSION,
      ctx,
    );
    eq(taskWakeThisTurn("turn_settlement_redelegate"), await taskWakeId(ORG, "task_601a_valid"), "P15 precondition: the real notification edge installed the settled task's own wake");
    await spawnTaint.settleFromTaskNotification(
      "Background task task_601a_valid (agent) is completed. Use task_peek to read its output.",
      SESSION,
      ctx,
    );
    recordRequesterIdentity(ctx, "turn_settlement_redelegate", "Task task_601a_valid completed successfully");
    eq(exactDispatchWakeThisTurn("turn_settlement_redelegate"), undefined, "P15 precondition: the framework settlement text contains no rendered wake envelope");
    eq(requesterThisTurn("turn_settlement_redelegate").kind, "unverified", "P15 precondition: the generic requester reader cannot attribute a framework-only settlement turn");

    await requested(
      { data: { actions: [{ kind: "subagent-call", callId: "call_settlement_redelegate", subagentName: "agent" }] } },
      ctx,
    );
    await handler({ data: { result: receiptResult("call_settlement_redelegate", "task_settlement_redelegate") } }, ctx);
    const secondWake = await taskWakeId(ORG, "task_settlement_redelegate");
    ok(typeof secondWake === "string" && secondWake.length > 0, "🔴 P15: the REAL dispatch hook accepts a second delegation from the host-attributed settlement turn");
    eq(await resolveUnifiedWakeTarget(store, ORG, secondWake!), THREAD_P, "🔴 P15: the second task still owes the original Slack thread, never the latest sibling wake");
  });

  await contextStorage.run(new ContextContainer(), async () => {
    const bindingBridge = await import("../agent/hooks/binding-bridge.js");
    const { delegatedNonMemberWakeThisTurn } = await import("../agent/identity/delegated-binding.js");
    const child: any = {
      channel: { kind: "subagent", continuationToken: `subagent:${SESSION}:call_settlement_redelegate` },
      session: {
        id: "sess-child-settlement-redelegate",
        parent: { sessionId: SESSION, callId: "call_settlement_redelegate", rootSessionId: SESSION },
        turn: { id: "turn_child_settlement_redelegate", sequence: 0 },
        auth: {
          current: {
            attributes: {
              oe_platform: "notion",
              workspace_id: "N_OTHER",
              page_id: "P_OTHER",
              discussion_id: "D_OTHER",
              oe_requester: "ADMIN_B",
              oe_chat_nonmember: "true",
            },
            principalId: "ADMIN_B",
            principalType: "notion-user",
          },
        },
      },
    };
    const started = (bindingBridge.default as unknown as { events: Record<string, (e: unknown, c: unknown) => Promise<void> | void> }).events["turn.started"]!;
    await started({ data: { turnId: "turn_child_settlement_redelegate", sequence: 0 } }, child);
    eq(bindFrom(child), BINDING_P, "🔴 P15 BINDING: the second child restores the first dispatch's Slack authority, never later Notion auth");
    recordRequesterIdentity(child, "turn_child_settlement_redelegate", "parent-authored worker brief");
    eq(requesterThisTurn("turn_child_settlement_redelegate"), { kind: "requester", principalId: "U_P" }, "🔴 P15 REQUESTER: the second child keeps original requester A, never later admin B");
    eq(delegatedNonMemberWakeThisTurn("turn_child_settlement_redelegate"), false, "🔴 P15 MEMBER GATE: the second child keeps the original member verdict, never later mutable auth");
  });

  await contextStorage.run(new ContextContainer(), async () => {
    const requesterHook = await import("../agent/hooks/requester-identity.js");
    const { renderFireWindowMessage } = await import("../agent/routines/fire-window.js");
    const { ROUTINE_MARKER } = await import("../agent/routines/routine.js");
    const ctx: any = seatCtx(W_DECISION, "turn_routine_dispatch");
    Object.assign(ctx.session.auth.current.attributes, {
      [ROUTINE_MARKER.id]: "routine_dispatch_test",
      [ROUTINE_MARKER.surface]: "slack/T1/C_OTHER",
      [ROUTINE_MARKER.org]: ORG,
      [ROUTINE_MARKER.fire]: W_DECISION,
    });
    noteTurnBoundary("turn_routine_dispatch", W_DECISION);
    const message = renderFireWindowMessage("gather the numbers and report", W_DECISION, ctx.session.auth.current.attributes);
    const received = (requesterHook.default as unknown as { events: Record<string, (e: unknown, c: unknown) => Promise<void> | void> }).events["message.received"]!;
    await received({ data: { message, turnId: "turn_routine_dispatch" } }, ctx);
    eq(uningressedTurn("turn_routine_dispatch"), false, "P15 routine precondition: the host fire is a real delivery even though it has no human trigger message");
    eq(exactDispatchWakeThisTurn("turn_routine_dispatch"), W_DECISION, "🔴 P15 ROUTINE CAPTURE: one structured fire marker supplies one exact dispatch wake");
    await requested({ data: { actions: [{ kind: "subagent-call", callId: "call_routine_dispatch", subagentName: "agent" }] } }, ctx);
    await handler({ data: { result: receiptResult("call_routine_dispatch", "task_routine_dispatch") } }, ctx);
    const wake = await taskWakeId(ORG, "task_routine_dispatch");
    eq(await resolveUnifiedWakeTarget(store, ORG, wake!), OTHER_THREAD, "🔴 P15 ROUTINE PARITY: a non-settlement host wake retains its exact dispatch authority");

    ctx.session.turn.id = "turn_after_routine_dispatch";
    noteTurnBoundary("turn_after_routine_dispatch", W_DECISION);
    await received({ data: { message: "Background task settled.", turnId: "turn_after_routine_dispatch" } }, ctx);
    eq(uningressedTurn("turn_after_routine_dispatch"), true, "P15 ROUTINE STALE precondition: a later framework turn inherits the same raw routine auth");
    eq(currentWakeId(ctx), undefined, "🔴 P15 ROUTINE STALE: inherited routine auth is not a current wake on the later settlement turn");
    eq(exactDispatchWakeThisTurn("turn_after_routine_dispatch"), undefined, "🔴 P15 ROUTINE STALE: no new marker means no dispatch authority, despite the stale fire id in auth");
  });

  await contextStorage.run(new ContextContainer(), async () => {
    const requesterHook = await import("../agent/hooks/requester-identity.js");
    const { renderFireWindowMessage } = await import("../agent/routines/fire-window.js");
    const ctx: any = seatCtx(W_DECISION, "turn_routine_coalesced");
    noteTurnBoundary("turn_routine_coalesced", W_DECISION);
    const message =
      renderFireWindowMessage("first stable-job fire", W_P) +
      "\n\n" +
      renderFireWindowMessage("second stable-job fire", W_DECISION);
    const received = (requesterHook.default as unknown as { events: Record<string, (e: unknown, c: unknown) => Promise<void> | void> }).events["message.received"]!;
    await received({ data: { message, turnId: "turn_routine_coalesced" } }, ctx);
    eq(exactDispatchWakeThisTurn("turn_routine_coalesced"), undefined, "🔴 P15 ROUTINE COALESCING: two stable-job fire markers are ambiguous even though session auth names only the last fire");
    await assert.rejects(
      async () => await requested({ data: { actions: [{ kind: "subagent-call", callId: "call_routine_coalesced", subagentName: "agent" }] } }, ctx),
      /dispatch authority is missing or ambiguous/,
      "🔴 P15 ROUTINE COALESCING: a pre-reply worker launch cannot silently inherit the last coalesced fire",
    );
    n++;
  });

  await contextStorage.run(new ContextContainer(), async () => {
    const requesterHook = await import("../agent/hooks/requester-identity.js");
    const { renderFireWindowMessage } = await import("../agent/routines/fire-window.js");
    const { ROUTINE_MARKER } = await import("../agent/routines/routine.js");
    const { markSilentRoutineTurn } = await import("../agent/routines/report.js");
    const ctx: any = seatCtx(W_DECISION, "turn_routine_silent_dispatch");
    ctx.session.auth.current.attributes[ROUTINE_MARKER.silent] = "true";
    noteTurnBoundary("turn_routine_silent_dispatch", W_DECISION);
    const message = renderFireWindowMessage("perform the work without an ordinary report", W_DECISION, ctx.session.auth.current.attributes);
    const received = (requesterHook.default as unknown as { events: Record<string, (e: unknown, c: unknown) => Promise<void> | void> }).events["message.received"]!;
    await received({ data: { message, turnId: "turn_routine_silent_dispatch" } }, ctx);
    markSilentRoutineTurn();
    eq(exactDispatchWakeThisTurn("turn_routine_silent_dispatch"), W_DECISION, "P15 SILENT WORK: the silence stamp does not erase the fire's worker dispatch address");
    await requested({ data: { actions: [{ kind: "subagent-call", callId: "call_routine_silent", subagentName: "agent" }] } }, ctx);
    await handler({ data: { result: receiptResult("call_routine_silent", "task_routine_silent") } }, ctx);
    const wake = await taskWakeId(ORG, "task_routine_silent");
    eq(await resolveUnifiedWakeTarget(store, ORG, wake!), OTHER_THREAD, "🔴 P15 SILENT WORK: silent affects conversational reporting, not worker launch or settlement routing");
  });

  await contextStorage.run(new ContextContainer(), async () => {
    const requesterHook = await import("../agent/hooks/requester-identity.js");
    const { renderFireWindowMessage } = await import("../agent/routines/fire-window.js");
    const { ROUTINE_MARKER } = await import("../agent/routines/routine.js");
    const unknownWake = "wake-routine-unregistered";
    const ctx: any = seatCtx(unknownWake, "turn_routine_unregistered");
    Object.assign(ctx.session.auth.current.attributes, {
      [ROUTINE_MARKER.id]: "routine_unregistered_test",
      [ROUTINE_MARKER.surface]: "slack/T1/C_OTHER",
      [ROUTINE_MARKER.org]: ORG,
      [ROUTINE_MARKER.fire]: unknownWake,
    });
    noteTurnBoundary("turn_routine_unregistered", unknownWake);
    const message = renderFireWindowMessage("gather the numbers and report", unknownWake, ctx.session.auth.current.attributes);
    const received = (requesterHook.default as unknown as { events: Record<string, (e: unknown, c: unknown) => Promise<void> | void> }).events["message.received"]!;
    await received({ data: { message, turnId: "turn_routine_unregistered" } }, ctx);
    eq(exactDispatchWakeThisTurn("turn_routine_unregistered"), unknownWake, "P15 ROUTINE FENCE: the host marker is captured before the durable row is resolved");
    await assert.rejects(
      async () => await requested({ data: { actions: [{ kind: "subagent-call", callId: "call_routine_unregistered", subagentName: "agent" }] } }, ctx),
      /dispatch authority is missing or ambiguous/,
      "🔴 P15 ROUTINE FENCE: an unregistered host-looking wake remains fail-closed",
    );
    n++;
  });

  await contextStorage.run(new ContextContainer(), async () => {
    const ctx = seatCtx(W_DECISION, "turn_uninstalled_redelegate");
    await assert.rejects(
      async () => await requested({ data: { actions: [{ kind: "subagent-call", callId: "call_uninstalled_redelegate", subagentName: "agent" }] } }, ctx),
      /dispatch authority is missing or ambiguous/,
      "🔴 P15 UNINSTALLED: a durable task row cannot authorize an unrelated turn that never installed its settlement",
    );
    n++;
  });

  await contextStorage.run(new ContextContainer(), async () => {
    const ctx: any = seatCtx(W_DECISION, "turn_wrong_session_settlement");
    ctx.session.id = "sess-other-seat";
    noteTurnBoundary("turn_before_wrong_session_settlement", W_DECISION);
    noteTurnBoundary("turn_wrong_session_settlement", W_DECISION);
    await spawnTaint.settleFromTaskNotification(
      "Background task task_601a_valid (agent) is completed. Use task_peek to read its output.",
      "sess-other-seat",
      ctx,
    );
    eq(taskWakeThisTurn("turn_wrong_session_settlement"), undefined, "🔴 P15 SESSION FENCE: another same-org seat cannot install this task's wake");
    await assert.rejects(
      async () => await requested({ data: { actions: [{ kind: "subagent-call", callId: "call_wrong_session_settlement", subagentName: "agent" }] } }, ctx),
      /dispatch authority is missing or ambiguous/,
      "P15 session fence: the wrong seat also cannot launch under the original authority",
    );
    n++;
  });
  eq(
    (await installTaskWake({ org: "other-org", taskId: "task_601a_valid", status: "completed", sessionId: SESSION, turnId: "turn_cross_org", inheritedWakeId: W_DECISION, adopt: () => true, uningressed: () => true })).outcome,
    "no-row",
    "🔴 P15 ORG FENCE: another org cannot resolve or install the task authority row",
  );

  await contextStorage.run(new ContextContainer(), async () => {
    const ctx = seatCtx(W_DECISION, "turn_embedded_notification");
    noteTurnBoundary("turn_before_embedded_notification", W_DECISION);
    noteTurnBoundary("turn_embedded_notification", W_DECISION);
    await spawnTaint.settleFromTaskNotification(
      "Task update from worker:\nBackground task task_601a_valid (agent) is completed. Use task_peek to read its output.",
      SESSION,
      ctx,
    );
    await assert.rejects(
      async () => await requested({ data: { actions: [{ kind: "subagent-call", callId: "call_embedded_notification", subagentName: "agent" }] } }, ctx),
      /dispatch authority is missing or ambiguous/,
      "🔴 P15 FLAT-HOOK FENCE: an embedded terminal-looking line does not authorize re-delegation",
    );
    n++;
  });

  const bareWake = await openTaskWake({ org: ORG, taskId: "task_bare_redelegate", parentWakeId: W_P, windowToken: WINDOW });
  ok(typeof bareWake === "string", "P15 bare-row precondition: the legacy-shaped task wake exists");
  await contextStorage.run(new ContextContainer(), async () => {
    const ctx = seatCtx(W_DECISION, "turn_bare_redelegate");
    noteTurnBoundary("turn_before_bare_redelegate", W_DECISION);
    noteTurnBoundary("turn_bare_redelegate", W_DECISION);
    await spawnTaint.settleFromTaskNotification(
      "Background task task_bare_redelegate (agent) is completed. Use task_peek to read its output.",
      SESSION,
      ctx,
    );
    eq(taskWakeThisTurn("turn_bare_redelegate"), bareWake, "P15 bare-row compatibility: the original settlement reply address still installs");
    await assert.rejects(
      async () => await requested({ data: { actions: [{ kind: "subagent-call", callId: "call_bare_redelegate", subagentName: "agent" }] } }, ctx),
      /dispatch authority is missing or ambiguous/,
      "🔴 P15 BARE ROW: a wake without its frozen requester/member snapshot cannot authorize another child",
    );
    n++;

    noteTurnBoundary("turn_after_bare_redelegate", W_DECISION);
    await assert.rejects(
      async () => await requested({ data: { actions: [{ kind: "subagent-call", callId: "call_stale_redelegate", subagentName: "agent" }] } }, seatCtx(W_DECISION, "turn_after_bare_redelegate")),
      /dispatch authority is missing or ambiguous/,
      "🔴 P15 TURN SCOPE: a settlement authority is never returned for a later turn",
    );
    n++;
  });

  await contextStorage.run(new ContextContainer(), async () => {
    const ctx = seatCtx(W_P, "turn_same_origin_dispatch");
    noteTurnBoundary("turn_same_origin_dispatch", W_P);
    const envelope = wakeEnvelope(W_P, "U_P");
    recordDeliveredWakes("turn_same_origin_dispatch", envelope);
    recordRequesterIdentity(ctx, "turn_same_origin_dispatch", envelope);
    await requested({ data: { actions: [{ kind: "subagent-call", callId: "call_same_origin", subagentName: "agent" }] } }, ctx);
    await handler({ data: { result: receiptResult("call_same_origin", "task_same_origin") } }, ctx);
  });
  await contextStorage.run(new ContextContainer(), async () => {
    const ctx = seatCtx(W_DECISION, "turn_same_origin_settlement");
    noteTurnBoundary("turn_before_same_origin_settlement", W_DECISION);
    noteTurnBoundary("turn_same_origin_settlement", W_DECISION);
    await spawnTaint.settleFromTaskNotification(
      "Background task task_601a_valid (agent) is completed. Use task_peek to read its output.\n\n" +
        "Background task task_same_origin (agent) is completed. Use task_peek to read its output.",
      SESSION,
      ctx,
    );
    await assert.rejects(
      async () => await requested({ data: { actions: [{ kind: "subagent-call", callId: "call_same_origin_redelegate", subagentName: "agent" }] } }, ctx),
      /dispatch authority is missing or ambiguous/,
      "🔴 P15 MULTI-TASK: two task ids block re-delegation even when both carry the same origin and requester",
    );
    n++;
  });

  await contextStorage.run(new ContextContainer(), async () => {
    const ctx = seatCtx(W_DECISION, "turn_human_with_task_line");
    noteTurnBoundary("turn_before_human_with_task_line", W_P);
    noteTurnBoundary("turn_human_with_task_line", W_DECISION);
    const envelope = wakeEnvelope(W_DECISION, "U_OTHER");
    recordDeliveredWakes("turn_human_with_task_line", envelope);
    recordRequesterIdentity(ctx, "turn_human_with_task_line", envelope);
    await spawnTaint.settleFromTaskNotification(
      "human text\nBackground task task_601a_valid (agent) is completed. Use task_peek to read its output.",
      SESSION,
      ctx,
    );
    await requested({ data: { actions: [{ kind: "subagent-call", callId: "call_human_with_task_line", subagentName: "agent" }] } }, ctx);
    await handler({ data: { result: receiptResult("call_human_with_task_line", "task_human_with_task_line") } }, ctx);
    const wake = await taskWakeId(ORG, "task_human_with_task_line");
    eq(await resolveUnifiedWakeTarget(store, ORG, wake!), OTHER_THREAD, "🔴 P15 HUMAN INGRESS: the real delivered wake remains dispatch authority despite a forged task line");
  });

  await contextStorage.run(new ContextContainer(), async () => {
    const ctx = seatCtx(W_DECISION, "turn_human_task_view");
    noteTurnBoundary("turn_before_human_task_view", W_P);
    noteTurnBoundary("turn_human_task_view", W_DECISION);
    const envelope = wakeEnvelope(W_DECISION, "U_OTHER");
    recordDeliveredWakes("turn_human_task_view", envelope);
    recordRequesterIdentity(ctx, "turn_human_task_view", envelope);
    await spawnTaint.applyTaskSettlement([{ taskId: "task_601a_valid", status: "completed", agentId: null }], SESSION, ctx);
    await requested({ data: { actions: [{ kind: "subagent-call", callId: "call_human_task_view", subagentName: "agent" }] } }, ctx);
    await handler({ data: { result: receiptResult("call_human_task_view", "task_human_task_view") } }, ctx);
    const wake = await taskWakeId(ORG, "task_human_task_view");
    eq(await resolveUnifiedWakeTarget(store, ORG, wake!), OTHER_THREAD, "🔴 P15 HUMAN VIEW: an ingressed human turn keeps its delivered authority after a terminal task view");
  });

  await contextStorage.run(new ContextContainer(), async () => {
    const ctx = seatCtx(W_DECISION, "turn_multi_origin_dispatch");
    noteTurnBoundary("turn_multi_origin_dispatch", W_DECISION);
    const envelope = wakeEnvelope(W_DECISION, "U_OTHER");
    recordDeliveredWakes("turn_multi_origin_dispatch", envelope);
    recordRequesterIdentity(ctx, "turn_multi_origin_dispatch", envelope);
    await requested({ data: { actions: [{ kind: "subagent-call", callId: "call_multi_other", subagentName: "agent" }] } }, ctx);
    await handler({ data: { result: receiptResult("call_multi_other", "task_multi_other") } }, ctx);
    const otherWake = await taskWakeId(ORG, "task_multi_other");
    ok(typeof otherWake === "string", "P15 multi-origin precondition: the other conversation's task has its own exact wake");
    eq(await resolveUnifiedWakeTarget(store, ORG, otherWake!), OTHER_THREAD, "P15 multi-origin precondition: the second task belongs to the other Slack thread");
  });

  await contextStorage.run(new ContextContainer(), async () => {
    const ctx = seatCtx(W_DECISION, "turn_multi_origin_settlement");
    noteTurnBoundary("turn_before_multi_origin_settlement", W_DECISION);
    noteTurnBoundary("turn_multi_origin_settlement", W_DECISION);
    await spawnTaint.settleFromTaskNotification(
      "Background task task_601a_valid (agent) is completed. Use task_peek to read its output.\n\n" +
        "Background task task_multi_other (agent) is completed. Use task_peek to read its output.",
      SESSION,
      ctx,
    );
    const firstWake = taskWakeThisTurn("turn_multi_origin_settlement");
    eq(firstWake, await taskWakeId(ORG, "task_601a_valid"), "P15 multi-origin precondition: the first host settlement installs its reply address");
    eq(taskWakeThisTurn("turn_multi_origin_settlement"), firstWake, "P15 multi-origin precondition: the reply plane keeps its first-write-wins address");
    await requested(
      { data: { actions: [{ kind: "tool-call", callId: "call_multi_origin_reply", toolName: "reply" }] } },
      ctx,
    );
    eq(claimTasksForAddressedWake("turn_multi_origin_settlement", firstWake!).length, 0, "P15 multi-origin precondition: a reply may address the first wake before another agent call");
    await assert.rejects(
      async () => await requested({ data: { actions: [{ kind: "subagent-call", callId: "call_multi_origin_redelegate", subagentName: "agent" }] } }, ctx),
      /dispatch authority is missing or ambiguous/,
      "🔴 P15 MULTI-ORIGIN: two settled tasks in one turn cannot silently choose one dispatch authority",
    );
    n++;
  });

  await contextStorage.run(new ContextContainer(), async () => {
    const ctx = seatCtx(W_DECISION, "turn_valid_missing_settlement");
    noteTurnBoundary("turn_before_valid_missing_settlement", W_DECISION);
    noteTurnBoundary("turn_valid_missing_settlement", W_DECISION);
    await spawnTaint.settleFromTaskNotification(
      "Background task task_601a_valid (agent) is completed. Use task_peek to read its output.\n\n" +
        "Background task task_missing_row (agent) is completed. Use task_peek to read its output.",
      SESSION,
      ctx,
    );
    await assert.rejects(
      async () => await requested({ data: { actions: [{ kind: "subagent-call", callId: "call_valid_missing_redelegate", subagentName: "agent" }] } }, ctx),
      /dispatch authority is missing or ambiguous/,
      "🔴 P15 PARTIAL BATCH: a missing second task row blocks re-delegation instead of leaving the valid first task authoritative",
    );
    n++;
  });

  await contextStorage.run(new ContextContainer(), async () => {
    const ctx = seatCtx(W_DECISION, "turn_task_view_redelegate");
    noteTurnBoundary("turn_before_task_view_redelegate", W_DECISION);
    noteTurnBoundary("turn_task_view_redelegate", W_DECISION);
    await spawnTaint.applyTaskSettlement([{ taskId: "task_multi_other", status: "completed", agentId: null }], SESSION, ctx);
    eq(taskWakeThisTurn("turn_task_view_redelegate"), await taskWakeId(ORG, "task_multi_other"), "P15 task-view compatibility: terminal view handling may still install the reply address");
    await assert.rejects(
      async () => await requested({ data: { actions: [{ kind: "subagent-call", callId: "call_task_view_redelegate", subagentName: "agent" }] } }, ctx),
      /dispatch authority is missing or ambiguous/,
      "🔴 P15 NOTIFICATION FENCE: a model-selected task view cannot authorize another child",
    );
    n++;
  });

  await contextStorage.run(new ContextContainer(), async () => {
    const bindingBridge = await import("../agent/hooks/binding-bridge.js");
    const missing: any = {
      channel: { kind: "subagent", continuationToken: `subagent:${SESSION}:call_missing` },
      session: {
        id: "sess-child-missing",
        parent: { sessionId: SESSION, callId: "call_missing", rootSessionId: SESSION },
        turn: { id: "turn_child_missing", sequence: 0 },
        auth: {
          current: {
            attributes: { oe_platform: "notion", workspace_id: "N_OTHER", page_id: "P_OTHER", discussion_id: "D_OTHER" },
            principalId: "N_USER",
          },
        },
      },
    };
    const started = (bindingBridge.default as unknown as { events: Record<string, (e: unknown, c: unknown) => Promise<void> | void> }).events["turn.started"]!;
    await assert.rejects(
      async () => await started({ data: { turnId: "turn_child_missing", sequence: 0 } }, missing),
      /delegated task binding unavailable: no-row/,
      "🔴 P14 FAIL-CLOSED LOSS: a child with no durable pointer aborts instead of adopting the later Notion auth",
    );
    n++;
    eq(bindFrom(missing).platform, "subagent", "P14 loss control: even after the refused hook, the later Notion binding never becomes worker authority");
  });

  await contextStorage.run(new ContextContainer(), async () => {
    const nativeParent = {
      channel: { kind: "slack", continuationToken: "slack:native-seat" },
      session: {
        id: "sess-native-parent",
        turn: { id: "turn_native_parent", sequence: 0 },
        auth: {
          current: {
            attributes: {
              team_id: "T1",
              channel_id: "C_NATIVE",
              channel_type: "channel",
              is_private: "false",
              is_ext_shared: "false",
              trust_checked: "true",
            },
            principalId: "U_NATIVE",
          },
        },
      },
    } as never;
    eq(currentWakeId(nativeParent), undefined, "P14 blank-token precondition: the degraded delegation edge carries no unified wake id");
    await requested({ data: { actions: [{ kind: "subagent-call", callId: "call_native", subagentName: "agent" }] } }, nativeParent);

    const nativeChild = {
      channel: { kind: "subagent", continuationToken: "subagent:sess-native-parent:call_native" },
      session: {
        id: "sess-native-child",
        parent: { sessionId: "sess-native-parent", callId: "call_native", rootSessionId: "sess-native-parent" },
        turn: { id: "turn_native_child", sequence: 0 },
        auth: {
          current: {
            attributes: { oe_platform: "notion", workspace_id: "N_OTHER", page_id: "P_OTHER", discussion_id: "D_OTHER" },
            principalId: "N_USER",
          },
        },
      },
    } as never;
    const bindingBridge = await import("../agent/hooks/binding-bridge.js");
    const started = (bindingBridge.default as unknown as { events: Record<string, (e: unknown, c: unknown) => Promise<void> | void> }).events["turn.started"]!;
    await started({ data: { turnId: "turn_native_child", sequence: 0 } }, nativeChild);
    eq(bindFrom(nativeChild).platform, "slack", "🔴 P14 BLANK-TOKEN DEGRADE: an admitted worker restores the dispatch platform without a unified wake row");
    eq(bindFrom(nativeChild).surface, "C_NATIVE", "P14 blank-token degrade: the direct snapshot restores the dispatch surface");
  });

  {
    await assert.rejects(
      () => registerUnifiedWakeTarget(store, ORG, "wake-p14-cross-platform", THREAD_P, iso(), WINDOW, undefined, undefined, "notion/N/P", { ...BINDING_P, platform: "notion", workspace: "N", surface: "P" }),
      /does not match its durable origin/,
      "P14 integrity: a Notion binding cannot ride a Slack origin",
    );
    n++;
    await assert.rejects(
      () => registerUnifiedWakeTarget(store, ORG, "wake-p14-extra-target", THREAD_P, iso(), WINDOW, undefined, undefined, "slack/T1/C_P", { ...BINDING_P, target: { channelId: "C_P", bearer: "must-not-persist" } }),
      /does not match its durable origin/,
      "P14 integrity: fields outside Slack's target schema never enter the durable row",
    );
    n++;
    await assert.rejects(
      () => registerUnifiedWakeTarget(store, ORG, "wake-p14-other-channel", THREAD_P, iso(), WINDOW, undefined, undefined, "slack/T1/C_OTHER", BINDING_DECISION),
      /does not match its durable origin/,
      "🔴 P14 integrity: a Slack channel-A origin cannot carry same-platform channel-B authority",
    );
    n++;
    await assert.rejects(
      () => registerUnifiedWakeTarget(store, ORG, "wake-p14-other-thread", THREAD_P, iso(), WINDOW, undefined, undefined, "slack/T1/C_P", { ...BINDING_P, threadTs: "999.9" }),
      /does not match its durable origin/,
      "🔴 P14 integrity: a Slack channel-A/thread-1 origin cannot carry channel-A/thread-2 authority",
    );
    n++;
    ok(
      (await import("../agent/channels/unified-window.js")).isWakeSurfaceBinding({
        org: ORG,
        platform: "teams",
        workspace: "tenant",
        surface: "conversation",
        mode: "channel",
        visibility: "private",
        trust: "internal",
        target: { serviceUrl: "https://smba.example.test", conversationId: "conversation", tenantId: undefined, channelId: undefined, teamId: undefined, conversationType: "channel", aadObjectId: undefined },
      }),
      "P14 integrity parity: mapper-realistic Teams targets may carry optional undefined values, which JSON safely drops",
    );
  }

  await contextStorage.run(new ContextContainer(), async () => {
    const ctx = seatCtx(W_DECISION, "turn_later_601");
    noteTurnBoundary("turn_later_601", W_DECISION);
    claimTasksForAddressedWake("turn_first_601", W_P);
    recordDeliveredWakes("turn_later_601", wakeEnvelope(W_DECISION, "U_OTHER"));
    recordRequesterIdentity(ctx, "turn_later_601", wakeEnvelope(W_DECISION, "U_OTHER"));
    eq(addressedWakeThisTurn("turn_later_601"), undefined, "🔴 P9: an address recorded for one turn is NOT returned for the next — asserted `=== undefined`");
    eq(addressedWakeThisTurn(undefined), undefined, "…and an unreadable turn id answers `undefined` too, never a guess");
    await requested({ data: { actions: [{ kind: "subagent-call", callId: "call_601c", subagentName: "agent" }] } }, ctx);
    await handler({ data: { result: receiptResult("call_601c", "task_601c") } }, ctx);
    const mintedC = await taskWakeId(ORG, "task_601c");
    ok(typeof mintedC === "string" && mintedC.length > 0, "P9: the later turn's dispatch minted a wake");
    eq(await resolveUnifiedWakeTarget(store, ORG, mintedC!), OTHER_THREAD, "🔴 P9: …registered against ITS OWN turn stamp. The fix adds a preference, it does not hand a stale address forward");
  });

  await contextStorage.run(new ContextContainer(), async () => {
    const ctx = seatCtx(W_P, "turn_single_601");
    noteTurnBoundary("turn_single_601", W_P);
    recordDeliveredWakes("turn_single_601", wakeEnvelope(W_P, "U_P"));
    recordRequesterIdentity(ctx, "turn_single_601", wakeEnvelope(W_P, "U_P"));
    await requested({ data: { actions: [{ kind: "subagent-call", callId: "call_601d", subagentName: "agent" }] } }, ctx);
    await handler({ data: { result: receiptResult("call_601d", "task_601d") } }, ctx);
    const mintedD = await taskWakeId(ORG, "task_601d");
    const claimed = claimTasksForAddressedWake("turn_single_601", W_P);
    eq(claimed.length, 1, "control: the single-wake turn still ledgers its dispatch");
    eq(
      await retargetTaskWakes({ org: ORG, tasks: claimed, addressedWakeId: W_P, windowToken: WINDOW, turnId: "turn_single_601" }),
      0,
      "🔴 THE NO-OP CONTROL: the task is ALREADY registered against the conversation the turn addressed, so NOTHING is written — every turn woken by one conversation is byte-identical to pre-OPE-601",
    );
    eq(await resolveUnifiedWakeTarget(store, ORG, mintedD!), THREAD_P, "…and its address is unchanged");
  });

  await contextStorage.run(new ContextContainer(), async () => {
    const ctx = seatCtx(W_P, "turn_v2_601");
    noteTurnBoundary("turn_v2_601", W_P);
    recordDeliveredWakes("turn_v2_601", wakeEnvelope(W_P, "U_P"));
    recordRequesterIdentity(ctx, "turn_v2_601", wakeEnvelope(W_P, "U_P"));
    await requested({ data: { actions: [{ kind: "subagent-call", callId: "call_601e", subagentName: "agent" }] } }, ctx);
    await handler({ data: { result: receiptResultV2("call_601e", "task_601e") } }, ctx);
    const mintedE = await taskWakeId(ORG, "task_601e");
    ok(typeof mintedE === "string" && mintedE.length > 0, "🔴 P11: the REAL hook minted a wake for an ENVELOPE B dispatch. Before the reader was widened this read `undefined` and every assertion below would have failed on a branch that never ran");
    eq(await resolveUnifiedWakeTarget(store, ORG, mintedE!), THREAD_P, "P11: …registered against the conversation that asked for the work");
    const target = await resolveAnswerableReplyTarget(store, ORG, mintedE!, WINDOW, "turn_settle_601e", mintedE!);
    ok(target.ok, "🔴 P11 END TO END: the settlement turn HAS a reply address for an eve 0.43.0+ delegation. This is the `no-row` outcome OPE-943 measured, closed");
    eq(target.ok ? target.origin : null, THREAD_P, "…and it names thread P, so the worker's answer lands where the work was asked for");
  });

  eq(
    await retargetTaskWakes({ org: ORG, tasks: [{ taskId: "task_601a_valid", wakeId: "wake-not-a-row" }], addressedWakeId: "wake-that-never-existed", windowToken: WINDOW, turnId: "t" }),
    0,
    "🔴 the re-point COPIES an origin, never guesses one: an addressed wake that does not resolve moves nothing",
  );

  await new Promise((r) => setTimeout(r, 60));
  {
    const rows = await readAudit({ org: ORG, action: TASK_WAKE_RETARGET_ACTION });
    eq(TASK_WAKE_RETARGET_ACTION, "unified.task_wake_retarget", "the re-point has its OWN action, apart from `unified.task_wake`");
    eq(rows.length, 0, "🔴 no task launches under provisional last-wake authority, so no after-launch retarget is needed");
  }
}

{
  const { stampUnifiedWindowAuth, OE_DELIVERY_ID_ATTR } = await import("../agent/channels/unified-window.js");
  const { taskWakeUnreadRefusalMessage, TASK_WAKE_UNREAD_REFUSAL_REASON } = await import("../agent/channels/task-wake.js");

  await contextStorage.run(new ContextContainer(), async () => {
    const W_PREV = "wake-prev-0597";
    await registerUnifiedWakeTarget(store, ORG, W_PREV, OTHER_THREAD, iso(), WINDOW);
    const minted597 = await openTaskWake({ org: ORG, taskId: "task_597", parentWakeId: W_ASK, windowToken: WINDOW });
    ok(typeof minted597 === "string" && minted597.length > 0, "P11a: the dispatch minted the task a wake of its own");

    noteTurnBoundary("turn_597_prev", W_PREV);
    const prevCtx = seatCtx(W_PREV, "turn_597_prev");
    eq(currentWakeId(prevCtx), W_PREV, "🔴 P11a THE CONTROL: the INGRESSED turn before it keeps its own address — asserted `=== W_PREV`, so the clearing below is scoped to the settlement turn and is not a blanket");

    noteTurnBoundary("turn_597", W_PREV);
    const ctx = seatCtx(W_PREV, "turn_597");
    eq(uningressedTurn("turn_597"), true, "P11a: the settlement turn is uningressed");
    eq(currentWakeId(ctx), undefined, "🔴 P11a: …so it holds no address — asserted `=== undefined`");

    const installed = await installTaskWake({ org: ORG, taskId: "task_597", status: "completed", sessionId: SESSION, turnId: "turn_597", inheritedWakeId: W_PREV });
    eq(installed.outcome, "installed", "P11a: reading the terminal view installs the task's identity");
    eq(currentWakeId(ctx), minted597, "🔴 P11a THE RECOVERY: the SAME turn now answers under the task's own wake — the install is what restores the address");
    eq(await resolveUnifiedWakeTarget(store, ORG, minted597!), ASK_THREAD, "🔴 P11a END TO END: …and that address is the thread that ASKED for the work, never the stale one");
  });

  {
    const copy = taskWakeUnreadRefusalMessage();
    ok(!/task_(peek|sleep|cancel|update)/.test(copy), "🔴 P11b: the refusal names NO task tool — there is no read that recovers this address, and eve 0.40.0 deletes the tool the old copy named");
    ok(copy.includes("no_reply"), "P11b: …and names the escape, so silence stays an explicit outcome rather than an accident");
    ok(!copy.includes(W_LAST) && !copy.includes(W_ASK), "🔴 P11b: it discloses NO wake id — every id this turn can see belongs to another conversation, so naming one would hand it the wrong address");
    eq(TASK_WAKE_UNREAD_REFUSAL_REASON, "task-wake-unread", "P11b: the `reply.refused` reason is its own string, so this hole is countable apart from every other refusal");
  }

  const W_DROP = "wake-drop-0597";
  await registerUnifiedWakeTarget(store, ORG, W_DROP, OTHER_THREAD, iso(), WINDOW);
  const d1 = "delivery-0597-a";
  const d2 = "delivery-0597-b";

  await contextStorage.run(new ContextContainer(), async () => {
    noteTurnBoundary("turn_drop_wakeid", W_DROP);
    noteTurnBoundary("turn_redrive_wakeid", W_DROP);
    eq(
      uningressedTurn("turn_redrive_wakeid"),
      true,
      "🔴 P12 THE FALSE POSITIVE THE NONCE CLOSES: on the WAKE ID the redriven turn reads as bringing no delivery, because the redrive re-stamps the ORIGINAL id on purpose",
    );
    eq(currentWakeId(seatCtx(W_DROP, "turn_redrive_wakeid")), undefined, "🔴 P12 THE HARM: …so the OPE-597 rule would strip the corrective wake of the very address it was sent to restore");
  });

  await contextStorage.run(new ContextContainer(), async () => {
    const first = seatCtx(W_DROP, "turn_drop", d1);
    eq(deliveryStampOf(first), d1, "P12: the nonce is what `deliveryStampOf` reads when it is present — never the wake id");
    noteTurnBoundary("turn_drop", deliveryStampOf(first));

    const redriven = seatCtx(W_DROP, "turn_redrive", d2);
    noteTurnBoundary("turn_redrive", deliveryStampOf(redriven));
    eq(uningressedTurn("turn_redrive"), false, "🔴 P12 THE FIX: the same wake id with a fresh nonce reads INGRESSED — a real delivery, correctly classified");
    eq(currentWakeId(redriven), W_DROP, "🔴 P12: …so the corrective wake KEEPS its address — asserted `=== W_DROP`, which is the id the redrive nudge tells the model to answer");
    eq(await resolveUnifiedWakeTarget(store, ORG, W_DROP), OTHER_THREAD, "P12: …and it resolves to the conversation whose prose was dropped");

    noteTurnBoundary("turn_settle_0597", deliveryStampOf(redriven));
    eq(uningressedTurn("turn_settle_0597"), true, "🔴 P12 THE CONTROL: a turn carrying the redriven turn's OWN nonce unchanged is still uningressed — the nonce classifies deliveries, it does not switch the detector off");
  });

  {
    eq(OE_DELIVERY_ID_ATTR, "oe_delivery_id", "the attribute name is pinned — the boundary reads it by name off a bag eve hands back across deploys");
    const withId = stampUnifiedWindowAuth({ attributes: {} as Record<string, unknown> }, "slack", "w1", undefined, undefined, WINDOW, undefined, "nonce-1");
    eq(withId.attributes?.[OE_DELIVERY_ID_ATTR], "nonce-1", "the stamp lands when the caller mints one");
    const without = stampUnifiedWindowAuth({ attributes: {} as Record<string, unknown> }, "slack", "w1", undefined, undefined, WINDOW, undefined);
    eq(Object.hasOwn(without.attributes ?? {}, OE_DELIVERY_ID_ATTR), false, "🔴 an omitted nonce leaves the bag BYTE-IDENTICAL — asserted `=== false` on the key's presence, not on its value");
    eq(deliveryStampOf({ session: { auth: { current: { attributes: { oe_wake_id: "w-old" } } } } } as never), "w-old", "🔴 an auth bag with NO nonce falls back to the raw wake id — an old deployment's delivery degrades to the pre-OPE-597 comparison, never to none");
    eq(deliveryStampOf({ session: { auth: { current: { attributes: {} } } } } as never), undefined, "…and a bag with neither answers `undefined`, which the boundary records as INGRESSED");
  }
}

{
  const { retargetTaskWakes } = await import("../agent/channels/task-wake.js");
  const { sameUnifiedConversation, sameUnifiedPlacement, unifiedPlacementRef } = await import("../agent/channels/unified-window.js");

  const ROOM_ASKED = { platform: "slack", channelId: "C_ROOM", replyAnchorTs: "900.1" } as const;
  const ROOM_ASIDE = { platform: "slack", channelId: "C_ROOM", replyAnchorTs: "900.2" } as const;
  const ROOM_UNPLACED = { platform: "slack", channelId: "C_ROOM" } as const;

  ok(sameUnifiedConversation(ROOM_ASKED, ROOM_ASIDE), "P13 precondition: the two wakes ARE one conversation — this is why the old skip fired");
  ok(!sameUnifiedPlacement(ROOM_ASKED, ROOM_ASIDE), "🔴 P13 precondition: …and they are NOT one placement — the axis the conversation test cannot see");
  eq(unifiedPlacementRef(ROOM_ASKED), "900.1", "P13: the placement axis reads the Slack anchor through the codec, never a platform check in core");
  eq(unifiedPlacementRef(ROOM_UNPLACED), undefined, "P13: an origin with no anchor names no placement — emptiness is absence");

  const W_ASKED = "wake-p13-asked";
  const W_ASIDE = "wake-p13-aside";
  await registerUnifiedWakeTarget(store, ORG, W_ASKED, ROOM_ASKED, iso(), WINDOW);
  await registerUnifiedWakeTarget(store, ORG, W_ASIDE, ROOM_ASIDE, iso(), WINDOW);

  const T13 = "task-p13";
  const W_TASK = "wake-p13-task";
  await registerUnifiedWakeTarget(store, ORG, W_TASK, ROOM_ASIDE, iso(), WINDOW);
  eq(
    (await resolveUnifiedWakeTarget(store, ORG, W_TASK)) as unknown,
    ROOM_ASIDE,
    "🔴 P13 THE DEFECT, ASSERTED FIRST: the task is registered under the ASIDE wake's anchor — the message nobody is waiting under",
  );

  const moved = await retargetTaskWakes({ org: ORG, tasks: [{ taskId: T13, wakeId: W_TASK }], addressedWakeId: W_ASKED, windowToken: WINDOW, turnId: "turn_p13" });
  eq(moved, 1, "🔴 P13 THE FIX: the re-point FIRED even though the two wakes are one conversation — the old `sameUnifiedConversation` skip returned 0 here");
  eq(
    (await resolveUnifiedWakeTarget(store, ORG, W_TASK)) as unknown,
    ROOM_ASKED,
    "🔴 P13 END TO END: the task's row now carries the ADDRESSED wake's placement — the worker's answer hangs under the message that asked for it",
  );

  const again = await retargetTaskWakes({ org: ORG, tasks: [{ taskId: T13, wakeId: W_TASK }], addressedWakeId: W_ASKED, windowToken: WINDOW, turnId: "turn_p13b" });
  eq(again, 0, "P13: a re-point to the SAME conversation AND the same placement writes nothing — the skip is narrowed, not removed");

  const W_ASKED_FLAT = "wake-p13-asked-flat";
  const W_TASK2 = "wake-p13-task2";
  await registerUnifiedWakeTarget(store, ORG, W_ASKED_FLAT, ROOM_UNPLACED, iso(), WINDOW);
  await registerUnifiedWakeTarget(store, ORG, W_TASK2, ROOM_ASIDE, iso(), WINDOW);
  await retargetTaskWakes({ org: ORG, tasks: [{ taskId: "task-p13b", wakeId: W_TASK2 }], addressedWakeId: W_ASKED_FLAT, windowToken: WINDOW, turnId: "turn_p13c" });
  eq(
    (await resolveUnifiedWakeTarget(store, ORG, W_TASK2)) as unknown,
    ROOM_ASIDE,
    "🔴 P13 CONTROL: the addressed wake carries no placement, so the row KEEPS its own — a carry fills a gap and never blanks one",
  );

  const W_ELSEWHERE = "wake-p13-elsewhere";
  const W_TASK3 = "wake-p13-task3";
  await registerUnifiedWakeTarget(store, ORG, W_ELSEWHERE, { platform: "slack", channelId: "C_ELSE" }, iso(), WINDOW);
  await registerUnifiedWakeTarget(store, ORG, W_TASK3, ROOM_ASKED, iso(), WINDOW);
  await retargetTaskWakes({ org: ORG, tasks: [{ taskId: "task-p13c", wakeId: W_TASK3 }], addressedWakeId: W_ELSEWHERE, windowToken: WINDOW, turnId: "turn_p13d" });
  eq(
    (await resolveUnifiedWakeTarget(store, ORG, W_TASK3)) as unknown,
    { platform: "slack", channelId: "C_ELSE" },
    "🔴 P13 CONTROL: a cross-conversation re-point carries NOTHING across — no anchor from the room it left",
  );
}

console.log(`task-wake-identity: ${n} assertions passed`);
