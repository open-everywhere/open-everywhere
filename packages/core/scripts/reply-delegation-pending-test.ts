import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const dir = join(tmpdir(), `open-everywhere-reply-delegation-pending-test-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
process.env.OE_ORG = "acme";
process.env.OE_WORKSPACE = "dev";

const { registerSlackTestBridge, registerSlackFixtureCodec, registerSlackFixtureMapper, registerSlackFixturePostArm } =
  await import("./_slack-test-stubs.js");
const { registerConfig } = await import("../agent/access/config.js");
const { defineDomain } = await import("../agent/memory/domain.js");
const { registerUnifiedWakeTarget, mintWakeId } = await import("../agent/channels/unified-window.js");
const { unifiedSupervisorToken } = await import("../agent/channels/unified-supervisor.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { taskWakeId } = await import("../agent/channels/task-wake.js");
const { DELEGATION_PENDING_REFUSAL_REASON, delegationPendingRefusalMessage, BRIDGE_WAKE_HELD_AUDIT_ACTION } = await import(
  "../agent/access/pending-delegation-signal.js"
);
const spawnTaint = await import("../agent/hooks/spawn-taint.js");

type BindableContext = import("../agent/identity/binding.js").BindableContext;

const ORG = "acme";
const DOMAIN = "payments";
const CHAN = "C1";
const SURFACE = `slack/T1/${CHAN}`;
const TOKEN = unifiedSupervisorToken(DOMAIN, 1);

const FABRICATION = '{"org":"default","tiers":[{"silo":"e2e-ambient-brain","files":[{"path":"RECURRING.md","bytes":3393}]}]}';
const REAL_REFUSAL = "memory_admin_list requires an org admin. Your id isn't on the org admins list, so I can't get that listing for you.";

const posted: { channel: string; text: string }[] = [];
registerSlackTestBridge({
  channel: { __fixture: "slack" } as never,
  confirmChannelInternal: async () => true,
  form: async (method: string, body: string) => {
    const p = new URLSearchParams(body);
    if (method === "chat.postMessage") posted.push({ channel: p.get("channel") ?? "", text: p.get("text") ?? "" });
    return { ok: true, ts: `ts-${posted.length}` } as never;
  },
});
registerSlackFixtureCodec();
registerSlackFixtureMapper();
registerSlackFixturePostArm();

registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [defineDomain({ name: DOMAIN, channels: [SURFACE], ambientSupervisor: true, mode: "unified" })],
  loadSilos: () => [],
  domainsForSurface: ({ surface }) => (surface === CHAN ? [DOMAIN] : []),
});

const store = getOperationalStore();

const replyTool = (await import("../agent/tools/reply.js")).default;
interface Armed {
  readonly execute: (input: Record<string, unknown>, ctx: unknown) => Promise<unknown>;
}
type Handler = (event: unknown, ctx: unknown) => unknown;
const arm = (ctx: unknown): Armed | null => (replyTool as unknown as { events: Record<string, Handler> }).events["session.started"]({}, ctx) as Armed | null;

const hook = (spawnTaint.default as unknown as { events: Record<string, (e: unknown, c: unknown) => Promise<void> | void> }).events["action.result"]!;

const receiptResult = (callId: string, taskId: string) => ({
  backgroundTask: { status: "working", taskId },
  callId,
  kind: "subagent-result",
  origin: "child",
  outcome: { kind: "parked", result: { kind: "succeeded", output: `Delegated as background task ${taskId} (working).` } },
  output: { agentId: "ag_agent:6666", status: "working", taskId },
  subagentName: "agent",
});

const peekResult = (taskId: string, status: string) => ({
  callId: `call_peek_${taskId}`,
  kind: "tool-result",
  toolName: "task_peek",
  output: { tasks: [{ taskId, status, metadata: { agentId: "ag_agent:6666", kind: "agent", mode: "background", name: "agent" } }] },
});

function ctxFor(turnWake: string, turnId: string): BindableContext {
  return {
    channel: { kind: "channel:unified", continuationToken: `unified:${TOKEN}` },
    session: {
      id: "reply-delegation-pending-test",
      turn: { id: turnId, sequence: 1 },
      auth: {
        current: {
          attributes: { oe_platform: "slack", oe_grain: "standing", oe_wake_id: turnWake, oe_window_token: TOKEN, channel_id: CHAN, team_id: "T1" },
          principalId: "U1",
          principalType: "slack-user",
        },
      },
    },
    agent: { name: "oe", nodeId: "__root__" },
  } as unknown as BindableContext;
}

const nodeRequire = createRequire(import.meta.url);
const eveRoot = dirname(nodeRequire.resolve("eve/package.json"));
const abs = (rel: string): string => pathToFileURL(join(eveRoot, rel)).href;
const { ContextContainer, contextStorage } = await import(abs("dist/src/context/container.js"));
const { SessionKey } = await import(abs("dist/src/context/keys.js"));
function newSession(): <T>(fn: () => Promise<T>) => Promise<T> {
  const c = new ContextContainer();
  c.set(SessionKey, { sessionId: "reply-delegation-pending-test", auth: null, turn: 1, parent: undefined });
  return <T>(fn: () => Promise<T>): Promise<T> => contextStorage.run(c, fn);
}

async function callReply(
  turnWake: string,
  turnId: string,
  wake: string,
  text: string,
  done: boolean,
): Promise<{ posted?: boolean; note?: string; error?: string }> {
  const ctx = ctxFor(turnWake, turnId);
  const armed = arm(ctx);
  if (!armed) return { error: "reply did not arm" };
  return armed
    .execute({ text, wake, done }, ctx)
    .then((r) => r as { posted?: boolean; note?: string })
    .catch((e: unknown) => ({ error: String(e) }));
}

async function wake(channelId: string, threadTs?: string): Promise<string> {
  const id = mintWakeId();
  await registerUnifiedWakeTarget(
    store,
    ORG,
    id,
    { platform: "slack", channelId, ...(threadTs === undefined ? {} : { threadTs }) },
    new Date().toISOString(),
    TOKEN,
  );
  return id;
}

const refusedRows = async (): Promise<Record<string, unknown>[]> =>
  (await readAudit({ org: ORG, action: "reply.refused" })).map((r) => (r.detail ?? {}) as Record<string, unknown>);

const roomHas = (needle: string): boolean => posted.some((m) => m.text.includes(needle));

{
  const inTurn = newSession();
  const wAsk = await wake("C_ASK", "111.1");
  const before = posted.length;

  await inTurn(async () => {
    await hook({ data: { result: receiptResult("call_696a", "task_696a") } }, ctxFor(wAsk, "turn_696"));
    const minted = await taskWakeId(ORG, "task_696a");
    ok(
      typeof minted === "string" && minted.length > 0,
      "🔴 §1 REACHABILITY: the REAL hook handler ran its dispatch branch — without this the refusals below would pass on a branch that never executed",
    );

    const fake = await callReply(wAsk, "turn_696", wAsk, FABRICATION, true);
    ok(typeof fake.error === "string", "🔴 §1: the `done:true` answer while the worker is still running is REFUSED");
    ok(fake.posted !== true, "§1: …and it reports no post");
    ok(posted.length === before, "🔴 §1/ROOM: NOTHING reached the room. This is the assertion OPE-696 exists for");
    ok(!roomHas("RECURRING.md"), "🔴 §1/ROOM: the fabricated listing is not in the room, asserted on its own content and not only on a count");

    const ack = await callReply(wAsk, "turn_696", wAsk, "I've handed this to a worker and will report back.", false);
    ok(ack.posted === true, "🔴 §1: the `done:false` hand-off note POSTS — the guard must never silence a delegating seat");
    ok(posted.length === before + 1, "§1/ROOM: exactly one message so far, and it is the ack");
    ok(
      typeof ack.note === "string" && ack.note.includes("has NOT reported yet"),
      "§1/NOTE: the success note states the worker has not reported, so the contract is taught at the moment of compliance rather than only by the refusal",
    );

    await hook({ data: { result: peekResult("task_696a", "completed") } }, ctxFor(wAsk, "turn_696"));

    const real = await callReply(wAsk, "turn_696", wAsk, REAL_REFUSAL, true);
    ok(real.posted === true, "🔴 §1 THE FIX, END TO END: once the worker's terminal view is in hand the turn CAN close the wake — the guard is a wait, not a wall");
    ok(roomHas("requires an org admin"), "🔴 §1/ROOM: the refusal the asker earned reached the room. Pre-fix this was discarded terminal prose");
    ok(posted.length === before + 2, "§1/ROOM: two messages — the ack and the real answer. The fabrication is not among them");
    ok(
      typeof real.note === "string" && !real.note.includes("has NOT reported yet"),
      "§1/NOTE: …and the settled reply's note drops the pending sentence, so the note tracks the state instead of decorating every post",
    );
  });
}

{
  const inTurn = newSession();
  const w = await wake("C_PLAIN", "222.2");
  const before = posted.length;

  const plain = await inTurn(() => callReply(w, "turn_plain", w, "Here is the answer, retrieved and checked.", true));
  ok(plain.posted === true, "🔴 §2: an ordinary `done:true` answer POSTS — the guard is not a blanket one-answer-per-turn rule");
  ok(posted.length === before + 1, "§2/ROOM: the answer reached the room");
  ok(
    typeof plain.note === "string" && plain.note.includes("ANSWERED") && !plain.note.includes("has NOT reported yet"),
    "§2/NOTE: the OPE-568 done note is unchanged, and carries no pending-worker sentence",
  );
}

{
  const inTurn = newSession();
  const w = await wake("C_SYNC", "333.3");
  const before = posted.length;

  await inTurn(async () => {
    await hook(
      { data: { result: { kind: "subagent-result", origin: "child", callId: "call_sync_696", subagentName: "agent", output: "the child's answer" } } },
      ctxFor(w, "turn_sync"),
    );
    const answer = await inTurn(() => callReply(w, "turn_sync", w, "The worker already answered, here it is.", true));
    ok(answer.posted === true, "🔴 §3: a SYNC delegation result records no pending dispatch, so the turn closes its wake normally");
    ok(posted.length === before + 1, "§3/ROOM: the answer reached the room");
  });
}

{
  const inSession = newSession();
  const wOld = await wake("C_OLD", "444.4");
  const wNew = await wake("C_NEW", "555.5");
  const before = posted.length;

  await inSession(async () => {
    await hook({ data: { result: receiptResult("call_696b", "task_696b") } }, ctxFor(wOld, "turn_old"));
    const blocked = await callReply(wOld, "turn_old", wOld, "An answer while the worker runs.", true);
    ok(typeof blocked.error === "string", "§4 precondition: the dispatching turn IS guarded");

    const later = await callReply(wNew, "turn_new", wNew, "A different ask, answered in full.", true);
    ok(
      later.posted === true,
      "🔴 §4: a LATER turn answers `done:true` even though the earlier turn's worker is still running — a long task must never mute the seat, and this is what a session-scoped record would break",
    );
    ok(posted.length === before + 1, "§4/ROOM: the later turn's answer reached the room, and the blocked one did not");
  });
}

{
  const inTurn = newSession();
  const wAsk = await wake("C_R_ASK", "666.6");
  const wSib = await wake("C_R_SIB", "777.7");
  const before = posted.length;

  await inTurn(async () => {
    await hook({ data: { result: receiptResult("call_696c", "task_696c") } }, ctxFor(wAsk, "turn_resid"));
    const sib = await callReply(wAsk, "turn_resid", wSib, "A full answer for the sibling conversation.", true);
    ok(
      typeof sib.error === "string",
      "🔴 §5: before the turn has addressed anything, a `done:true` to a SIBLING wake is ALSO refused — this is OPE-601's own accepted residual, inherited rather than re-invented",
    );
    ok(posted.length === before, "§5/ROOM: nothing posted");
    const sibOk = await callReply(wAsk, "turn_resid", wSib, "A full answer for the sibling conversation.", false);
    ok(sibOk.posted === true, "🔴 §5: `done:false` still posts the sibling's answer — the residual costs an open wake, never a lost message");
    ok(posted.length === before + 1, "§5/ROOM: the sibling got its answer");
  });
}

{
  const w = await wake("C_NOCTX", "888.8");
  const before = posted.length;

  const first = await callReply(w, "turn_noctx", w, "An answer with no session context.", true);
  ok(first.posted === true, "🔴 §6/FAIL-OPEN: with no eve context the guard is OFF and the reply posts — an unavailable signal never turns a delivered answer into an error");
  ok(posted.length === before + 1, "§6/ROOM: the message reached the room, which is the honest bound on this fix: it needs the turn's own state to work");
}

{
  const rows = await refusedRows();
  const mine = rows.filter((d) => d["reason"] === DELEGATION_PENDING_REFUSAL_REASON);
  ok(mine.length === 3, `🔴 §7/AUDIT: every refusal above is a ROW, not an absence (expected 3, saw ${mine.length})`);
  ok(DELEGATION_PENDING_REFUSAL_REASON === "delegation-pending", "§7/AUDIT: under its own reason string");
  ok(
    rows.every((d) => d["reason"] !== "answered-this-turn"),
    "🔴 §7/AUDIT: none of these is miscounted as an OPE-568 double-post — a seat answering over its own running worker is a different habit and must be countable apart",
  );
  ok(mine.every((d) => d["route"] === "tool"), "§7/AUDIT: route stamped, matching the reply.post join shape");
  ok(mine.every((d) => typeof d["wakeId"] === "string" && (d["wakeId"] as string).length > 0), "§7/AUDIT: each row names the wake it refused");
  ok(
    !JSON.stringify(rows).includes("RECURRING.md"),
    "🔴 §7/AUDIT: the attempted TEXT never reaches the audit detail — the fabrication must not be preserved anywhere a reader could mistake it for a real record",
  );
}

{
  const copy = delegationPendingRefusalMessage();
  ok(copy.includes("NOTHING was posted"), "🔴 §8: the copy tells the model its call posted nothing, so it does not retry believing the post failed");
  ok(copy.includes("done:false"), "🔴 §8: …and names the legitimate move, which is the whole reason the refusal is not silent");
  ok(copy.includes("fabrication"), "🔴 §8: …and names the mistake in the words the model needs, so the steer is about honesty and not only about a flag");
  ok(!copy.includes("task_"), "§8: it discloses no task id — a task id is not an address the model can act on");
}

{
  const unifiedAdapter = ((await import("../agent/channels/unified.js")).default as unknown as {
    adapter: Record<string, (data: unknown, ctx: unknown) => Promise<void>>;
  }).adapter;
  ok(typeof unifiedAdapter["message.completed"] === "function", "🔴 §9 REACHABILITY: the unified channel really does register message.completed — the bridge lives inside it");

  const adapterCtx = { session: { continuation: { token: `unified:${TOKEN}` } } };
  const bridgeComplete = (text: string): Promise<void> =>
    unifiedAdapter["message.completed"]!({ finishReason: "stop", message: text }, adapterCtx);

  function bridgeSession(turnWake: string, turnId: string): <T>(fn: () => Promise<T>) => Promise<T> {
    const c = new ContextContainer();
    c.set(SessionKey, {
      sessionId: "reply-delegation-pending-test",
      auth: {
        current: {
          attributes: {
            oe_platform: "slack",
            oe_grain: "standing",
            oe_addressing: "direct-mention",
            oe_wake_id: turnWake,
            oe_window_token: TOKEN,
            channel_id: CHAN,
            team_id: "T1",
          },
          principalId: "U1",
          principalType: "slack-user",
        },
      },
      turn: { id: turnId, sequence: 1 },
      parent: undefined,
    });
    return <T>(fn: () => Promise<T>): Promise<T> => contextStorage.run(c, fn);
  }

  const answeredAt = async (wakeId: string): Promise<string | undefined> => (await store.getUnifiedWakeRecord(ORG, wakeId))?.answeredAt;
  const heldRows = async (): Promise<Record<string, unknown>[]> =>
    (await readAudit({ org: ORG, action: BRIDGE_WAKE_HELD_AUDIT_ACTION })).map((r) => (r.detail ?? {}) as Record<string, unknown>);

  {
    const wBridge = await wake("C_BRIDGE", "901.1");
    const before = posted.length;
    const inTurn = bridgeSession(wBridge, "turn_701");

    await inTurn(async () => {
      await hook({ data: { result: receiptResult("call_701a", "task_701a") } }, ctxFor(wBridge, "turn_701"));

      const refused = await callReply(wBridge, "turn_701", wBridge, FABRICATION, true);
      ok(typeof refused.error === "string", "§9a precondition: the reply tool refuses the fabricated `done:true`");
      ok(posted.length === before, "§9a precondition: nothing posted through the tool");

      await bridgeComplete(FABRICATION);
    });

    ok(
      posted.length === before + 1,
      "🔴 §9a/ROOM: the bridge still POSTS the model's terminal prose. The guard must never delete the model's text — a swallowed bridge leaves the room with silence, which is a worse failure than a bad answer that can still be corrected",
    );
    ok(
      (await answeredAt(wBridge)) === undefined,
      "🔴 §9a THE FIX: the wake is NOT marked answered while the dispatched worker still owes it. This is the assertion OPE-701 exists for — pre-fix the bridge closed the wake the reply tool had just been stopped from closing",
    );

    const held = await heldRows();
    ok(held.length === 1, `🔴 §9a/AUDIT: the held wake is a ROW, not an absence (expected 1, saw ${held.length})`);
    ok(held[0]?.["wakeId"] === wBridge, "§9a/AUDIT: the row names the wake it held open");
    ok(!JSON.stringify(held).includes("RECURRING.md"), "🔴 §9a/AUDIT: the prose never reaches the audit detail — the row records the decision, not the text");

    const wLater = await wake("C_LATER", "902.2");
    const landed = await bridgeSession(wLater, "turn_701_later")(() => callReply(wLater, "turn_701_later", wBridge, REAL_REFUSAL, true));
    ok(
      landed.posted === true,
      "🔴 §9a THE POINT: on a later turn the worker's real answer LANDS on the held wake through the fence's pending arm — the arm that refuses an answered wake. Without the fix this reply is refused as `answered` and the fabrication stands as the final word",
    );
    ok(posted.length === before + 2, "§9a/ROOM: the correction reached the room");
    ok(typeof (await answeredAt(wBridge)) === "string", "§9a: …and THAT reply closes the wake normally, so the hold is a wait and not a leak");
  }

  {
    const wPlain = await wake("C_BRIDGE_PLAIN", "903.3");
    const before = posted.length;
    const heldBefore = (await heldRows()).length;

    await bridgeSession(wPlain, "turn_701_plain")(() => bridgeComplete("Here is the answer, retrieved and checked."));

    ok(posted.length === before + 1, "§9b/ROOM: the ordinary bridged prose reached the room");
    ok(
      typeof (await answeredAt(wPlain)) === "string",
      "🔴 §9b NEGATIVE CONTROL: with no pending dispatch the bridge marks the wake ANSWERED exactly as before. The guard is one condition on the mark, not the removal of it",
    );
    ok((await heldRows()).length === heldBefore, "§9b/AUDIT: …and it writes no held-wake row, so the row counts only the turns the guard acted on");
  }
}

console.log(`✓ reply-delegation-pending: ${passed} assertions passed`);
