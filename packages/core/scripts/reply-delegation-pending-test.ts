import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";

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
_setDeploymentIdentityForTest({ org: "acme", workspace: "dev" });

const { registerSlackTestBridge, registerSlackFixtureCodec, registerSlackFixtureMapper, registerSlackFixturePostArm } =
  await import("./_slack-test-stubs.js");
const { registerConfig } = await import("../agent/access/config.js");
const { defineDomain } = await import("../agent/memory/domain.js");
const { registerUnifiedWakeTarget, resolveUnifiedWakeTarget, mintWakeId, shouldBridgeAddressedProse } = await import("../agent/channels/unified-window.js");
const { unifiedSupervisorToken } = await import("../agent/channels/unified-supervisor.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { taskWakeId, TASK_WAKE_RETARGET_ACTION } = await import("../agent/channels/task-wake.js");
const { addressedWakeThisTurn } = await import("../agent/access/dispatch-origin-signal.js");
const { consumeRepliedThisTurn } = await import("../agent/channels/reply-signal.js");
const { DELEGATION_PENDING_REFUSAL_REASON, delegationPendingRefusalMessage, BRIDGE_WAKE_HELD_AUDIT_ACTION } = await import(
  "../agent/access/pending-delegation-signal.js"
);
const turnDelivery = await import("../agent/channels/turn-delivery.js");
const { withReplierPrefix } = turnDelivery;
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

const receiptResultV2 = (callId: string, taskId: string) => ({
  callId,
  kind: "tool-result",
  toolName: "agent",
  output: { agentId: "ag_agent:6666", status: "working", taskId },
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

const editTool = (await import("../agent/tools/edit_reply.js")).default;
const armEdit = (ctx: unknown): { readonly execute: (i: Record<string, unknown>, c: unknown) => Promise<unknown> } | null =>
  (editTool as unknown as { events: Record<string, (e: unknown, c: unknown) => unknown> }).events["session.started"]!({}, ctx) as never;

async function callEdit(
  turnWake: string,
  turnId: string,
  wake: string,
  messageId: string,
  text: string,
): Promise<{ edited?: boolean; note?: string; error?: string }> {
  const ctx = ctxFor(turnWake, turnId);
  const armed = armEdit(ctx);
  if (!armed) return { error: "edit_reply did not arm" };
  return armed
    .execute({ text, wake, message_id: messageId }, ctx)
    .then((r) => r as { edited?: boolean; note?: string })
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
  const wAsk = await wake("C_ASK_V2", "111.2");
  const before = posted.length;

  await inTurn(async () => {
    await hook({ data: { result: receiptResultV2("call_943a", "task_943a") } }, ctxFor(wAsk, "turn_943"));
    const minted = await taskWakeId(ORG, "task_943a");
    ok(typeof minted === "string" && minted.length > 0, "🔴 §1B REACHABILITY: the REAL hook ran BRANCH 1 for an ENVELOPE B receipt and minted the wake. Before the reader was widened this read `undefined`, and the refusal below would pass on a branch that never ran");

    const fake = await callReply(wAsk, "turn_943", wAsk, FABRICATION, true);
    ok(typeof fake.error === "string", "🔴 §1B THE ACCEPTANCE: a `done:true` answer while an ENVELOPE B worker is still running is REFUSED");
    ok(posted.length === before, "🔴 §1B/ROOM: NOTHING reached the room");

    const ack = await callReply(wAsk, "turn_943", wAsk, "I've handed this to a worker and will report back.", false);
    ok(ack.posted === true, "§1B: the `done:false` hand-off note still POSTS");

    await hook({ data: { result: peekResult("task_943a", "completed") } }, ctxFor(wAsk, "turn_943"));
    const real = await callReply(wAsk, "turn_943", wAsk, REAL_REFUSAL, true);
    ok(real.posted === true, "🔴 §1B END TO END: once the ENVELOPE B worker settles the turn CAN close the wake — the guard is a wait, not a wall, on both envelopes");
    ok(posted.length === before + 2, "§1B/ROOM: two messages — the ack and the real answer, and not the fabrication");
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
  ok(mine.length === 4, `🔴 §7/AUDIT: every refusal above is a ROW, not an absence (expected 4, saw ${mine.length})`);
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

{
  const lastPosted = (): string => posted[posted.length - 1]?.text ?? "";
  const HANDOFF = "I've handed this to a worker and will report back.";

  {
    const inTurn = newSession();
    const w = await wake("C_FRAME_TOOL", "1001.1");
    const before = posted.length;

    await inTurn(async () => {
      await hook({ data: { result: receiptResult("call_699a", "task_699a") } }, ctxFor(w, "turn_699a"));
      const ack = await callReply(w, "turn_699a", w, HANDOFF, false);
      ok(ack.posted === true, "§10a precondition: the `done:false` hand-off posts");
      ok(
        typeof ack.note === "string" && ack.note.includes("has NOT reported yet"),
        "🔴 §10a/NOTE: the tool result tells the model its worker has not reported, so it knows it does not hold the answer",
      );
      ok(
        typeof ack.note === "string" && ack.note.includes("still working on it") && ack.note.includes("do not present what you have as the final result"),
        "🔴 §10a/NOTE: …and it instructs the model to SAY SO in its own words — the host adds no line of its own, so an unwritten caveat is an unsaid one",
      );
    });

    ok(posted.length === before + 1, "§10a/ROOM: exactly one message reached the room");
    ok(
      lastPosted() === HANDOFF,
      `🔴 §10a: the posted body is the model's text BYTE-IDENTICAL, even on the turn whose worker still owes the answer. The host asserts nothing in the room — that is what OPE-1516 removed, and a body longer than the model's text means it came back (saw: ${JSON.stringify(lastPosted().slice(0, 120))})`,
    );
  }

  {
    const inTurn = newSession();
    const w = await wake("C_FRAME_EDIT", "1007.7");
    const before = posted.length;

    await inTurn(async () => {
      await hook({ data: { result: receiptResult("call_1544a", "task_1544a") } }, ctxFor(w, "turn_1544a"));
      const ack = await callReply(w, "turn_1544a", w, HANDOFF, false);
      ok(ack.posted === true, "§10g precondition: the `done:false` hand-off posts, so there is an own post to edit");

      const edited = await callEdit(w, "turn_1544a", w, "ts-" + String(posted.length), "The hand-off, reworded.");
      ok(edited.edited === true, "§10g precondition: the edit lands — the message is ours, at this locus, inside the window");
      ok(
        typeof edited.note === "string" && edited.note.includes("has NOT reported yet"),
        "🔴 §10g/NOTE: the EDIT's tool result tells the model its worker has not reported — the same fact the reply door already carried",
      );
      ok(
        typeof edited.note === "string" && edited.note.includes("do not present what you have as the final result"),
        "🔴 §10g/NOTE: …and instructs it not to present what it has as the final result. Without this, editing the caveat away reds NOTHING",
      );
    });
    ok(posted.length === before + 1, "§10g/ROOM: an edit adds no message to the room");
  }

  {
    const inTurn = newSession();
    const w = await wake("C_FRAME_EDIT_PLAIN", "1008.8");
    await inTurn(async () => {
      const first = await callReply(w, "turn_1544b", w, "An ordinary answer.", true);
      ok(first.posted === true, "§10h precondition: the ordinary answer posts");
      const edited = await callEdit(w, "turn_1544b", w, "ts-" + String(posted.length), "An ordinary answer, corrected.");
      ok(edited.edited === true, "§10h precondition: the edit lands");
      ok(
        typeof edited.note === "string" && !edited.note.includes("has NOT reported yet"),
        "🔴 §10h NEGATIVE CONTROL: a turn with no pending worker gets NO instruction — the note is a condition, not boilerplate on every edit",
      );
    });
  }

  {
    const inTurn = newSession();
    const w = await wake("C_FRAME_PLAIN", "1002.2");
    const before = posted.length;
    const TEXT = "Here is the answer, retrieved and checked.";

    const plain = await inTurn(() => callReply(w, "turn_699b", w, TEXT, true));
    ok(plain.posted === true, "§10b precondition: the ordinary answer posts");
    ok(posted.length === before + 1, "§10b/ROOM: one message reached the room");
    ok(
      lastPosted() === TEXT,
      `🔴 §10b NEGATIVE CONTROL: an ordinary reply is delivered BYTE-IDENTICAL to what the model wrote (saw: ${JSON.stringify(lastPosted().slice(0, 120))})`,
    );
    ok(
      typeof plain.note === "string" && !plain.note.includes("has NOT reported yet"),
      "🔴 §10b: …and the tool result carries NO pending-work instruction on a turn that delegated nothing — the note is a condition, not boilerplate on every reply",
    );
  }

  {
    const inTurn = newSession();
    const w = await wake("C_FRAME_SETTLE", "1003.3");
    const REAL = "The worker reports: memory_admin_list requires an org admin.";

    await inTurn(async () => {
      await hook({ data: { result: receiptResult("call_699c", "task_699c") } }, ctxFor(w, "turn_699c"));

      const pending = await callReply(w, "turn_699c", w, HANDOFF, false);
      ok(pending.posted === true, "§10c precondition: the hand-off posts while the worker runs");
      ok(typeof pending.note === "string" && pending.note.includes("has NOT reported yet"), "§10c precondition: …and the model was instructed that its worker still owes the answer");

      await hook({ data: { result: peekResult("task_699c", "completed") } }, ctxFor(w, "turn_699c"));

      const real = await callReply(w, "turn_699c", w, REAL, true);
      ok(real.posted === true, "§10c precondition: the settled answer posts");
    });

    ok(
      lastPosted() === REAL,
      `🔴 §10c THE CONDITION, ISOLATED: once the worker has reported, the SAME wake in the SAME turn posts the model's text verbatim. The INSTRUCTION tracks the ledger, not the conversation, and the body was never the host's to write (saw: ${JSON.stringify(lastPosted().slice(0, 120))})`,
    );
    ok(!lastPosted().includes(HANDOFF), "§10c: …and the settled answer replaced the hand-off text rather than accumulating on top of it");
  }

  {
    const wB = await wake("C_FRAME_BRIDGE", "1004.4");
    const before = posted.length;

    await bridgeSession(wB, "turn_699d")(async () => {
      await hook({ data: { result: receiptResult("call_699d", "task_699d") } }, ctxFor(wB, "turn_699d"));
      const refused = await callReply(wB, "turn_699d", wB, FABRICATION, true);
      ok(typeof refused.error === "string", "§10d precondition: the reply tool refuses the fabricated `done:true`");
      await bridgeComplete(FABRICATION);
    });

    ok(posted.length === before + 1, "§10d/ROOM: the bridge posted the model's prose, as OPE-701 requires");
    ok(
      lastPosted() === FABRICATION,
      `🔴 §10d: the BRIDGED prose is delivered BYTE-IDENTICAL too. This is the path the refusal itself opens, and the host adds nothing on it either — the two write paths must agree about the host's silence, or one of them starts speaking in the room (saw: ${JSON.stringify(lastPosted().slice(0, 120))})`,
    );
    ok((await answeredAt(wB)) === undefined, "🔴 §10d: …and OPE-701's hold is INTACT — this is the guarantee that survived OPE-1516. The conversation stays open for the worker's real answer, which is the mechanism that outlived the frame");
  }

  {
    const wP = await wake("C_FRAME_BRIDGE_PLAIN", "1005.5");
    const before = posted.length;
    const TEXT = "Here is the bridged answer, retrieved and checked.";

    await bridgeSession(wP, "turn_699e")(() => bridgeComplete(TEXT));

    ok(posted.length === before + 1, "§10e/ROOM: the ordinary bridged prose reached the room");
    ok(
      lastPosted() === TEXT,
      `🔴 §10e NEGATIVE CONTROL: with no pending dispatch the bridge delivers the prose BYTE-IDENTICAL. Both enforcing paths need their own negative control, because each reads the ledger at its own call site (saw: ${JSON.stringify(lastPosted().slice(0, 120))})`,
    );
    ok(typeof (await answeredAt(wP)) === "string", "§10e: …and it still marks the wake answered, so this leg also re-pins that OPE-699 changed nothing about the mark");
  }

  {
    ok(!("PENDING_WORK_FRAME" in turnDelivery), "🔴 §10f: `turn-delivery` exports NO pending-work frame constant. OPE-1516 removed the host's line from the room; an export named here is that line coming back");
    ok(!("withPendingWorkFrame" in turnDelivery), "🔴 §10f: …and no `withPendingWorkFrame` helper either — the composition that applied it is gone, not merely unused");
    const labelled = withReplierPrefix("body", { taskLabel: "audit the ledger" });
    ok(labelled === "[audit the ledger] body", "🔴 §10f: the replier tier label is now the ONLY host addition to a posted body — WHO is speaking, and nothing about what the message is");
    ok(withReplierPrefix("body", undefined) === "body", "§10f: …and a bare supervisor reply is untouched, so no post carries a host addition by default");
  }
}

{
  const taskChannel = async (taskId: string): Promise<string | undefined> => {
    const w = await taskWakeId(ORG, taskId);
    if (w === undefined) return undefined;
    const origin = await resolveUnifiedWakeTarget(store, ORG, w);
    return origin === null ? undefined : (origin as { channelId?: string }).channelId;
  };
  const lastChannel = (): string => posted[posted.length - 1]?.channel ?? "";

  {
    const wTurn = await wake("C_706_TURN", "1101.1");
    const wSib = await wake("C_706_SIB", "1102.2");
    const before = posted.length;
    const addressedAtBridge: (string | undefined)[] = [];

    await bridgeSession(wTurn, "turn_706a")(async () => {
      await hook({ data: { result: receiptResult("call_706a", "task_706a") } }, ctxFor(wTurn, "turn_706a"));
      const refused = await callReply(wTurn, "turn_706a", wTurn, FABRICATION, true);
      ok(typeof refused.error === "string", "§11a precondition: the reply tool refuses the fabricated `done:true` — the refusal is what leaves `replied` false and opens the bridge");
      addressedAtBridge.push(addressedWakeThisTurn("turn_706a"));
      await bridgeComplete(FABRICATION);
    });

    ok(addressedAtBridge.length === 1, "§11a: the turn body ran and took its reading");
    ok(
      addressedAtBridge[0] === undefined,
      `🔴 §11a THE STRUCTURAL PRECONDITION: a turn that reaches the bridge has addressed NOTHING, so the dispatch edge read \`currentWakeId\` and not an addressed wake (saw: ${JSON.stringify(addressedAtBridge[0])})`,
    );
    ok(posted.length === before + 1, "§11a/ROOM: the bridge posted the prose, as OPE-701 requires");
    ok(
      (await resolveUnifiedWakeTarget(store, ORG, wSib)) !== null,
      "§11a: the sibling wake is a LIVE registered wake on this same window — the task could have been pointed there, so the check below is not a strawman",
    );
    const reportsInto = await taskChannel("task_706a");
    ok(
      reportsInto === lastChannel(),
      `🔴 §11a THE HANDOFF: the worker will report into the SAME conversation the bridge just answered. There is no sibling to re-point, which is why the bridge needs no \`retargetTaskWakes\` call. If a change ever lets a bridge turn answer a different wake, this assertion is what goes red (task reports into ${JSON.stringify(reportsInto)}, bridge answered ${JSON.stringify(lastChannel())})`,
    );
    ok(reportsInto === "C_706_TURN", "§11a: …and that conversation is the turn's own, never the sibling");
    ok((await answeredAt(wTurn)) === undefined, "§11a: …and OPE-701's hold is intact — the wake stays answerable for the worker's real report");
  }

  {
    ok(
      shouldBridgeAddressedProse("direct-mention", true, undefined) === false,
      "🔴 §11b: a turn whose reply tool POSTED can never reach the bridge — the gate reads `replied`",
    );
    ok(shouldBridgeAddressedProse("direct-mention", false, undefined) === true, "§11b: …and a turn whose reply tool posted nothing can, which is the state §11a runs in");

    const w = await wake("C_706_ADDRESSED", "1103.3");
    const before = posted.length;
    const addressed: (string | undefined)[] = [];
    const replied: boolean[] = [];

    await newSession()(async () => {
      const post = await callReply(w, "turn_706b", w, "An ordinary answer, retrieved and checked.", true);
      ok(post.posted === true, "§11b precondition: the reply posts");
      addressed.push(addressedWakeThisTurn("turn_706b"));
      replied.push(consumeRepliedThisTurn("turn_706b"));
    });

    ok(posted.length === before + 1, "§11b/ROOM: the answer reached the room");
    ok(addressed[0] === w, "🔴 §11b: a successful reply RECORDS the wake it addressed…");
    ok(replied[0] === true, "🔴 §11b: …and the SAME post marks `replied`, so the two signals can never disagree…");
    ok(
      shouldBridgeAddressedProse("direct-mention", replied[0] ?? false, undefined) === false,
      "🔴 §11b: …so the bridge cannot fire on a turn that has addressed a wake. §11a's `undefined` is therefore structural, not a property of its fixture",
    );
  }

  {
    const wAsk = await wake("C_706_ASK", "1104.4");
    const wOther = await wake("C_706_OTHER", "1105.5");
    const before = posted.length;
    const retargetsBefore = (await readAudit({ org: ORG, action: TASK_WAKE_RETARGET_ACTION })).length;

    await newSession()(async () => {
      await hook({ data: { result: receiptResult("call_706c", "task_706c") } }, ctxFor(wAsk, "turn_706c"));
      ok((await taskChannel("task_706c")) === "C_706_ASK", "§11c precondition: the dispatch edge registered the task against the turn's own wake");
      const sib = await callReply(wAsk, "turn_706c", wOther, "The sibling's answer, part one.", false);
      ok(sib.posted === true, "§11c precondition: the sibling's `done:false` answer posts");
    });

    ok(posted.length === before + 1, "§11c/ROOM: the sibling got its answer");
    ok(
      (await taskChannel("task_706c")) === "C_706_OTHER",
      "🔴 §11c THE CONTRAST: on the REPLY path the pending task really does move to the conversation the turn answered. That is what §11a's read is capable of seeing, so §11a's unchanged answer is an observation and not a dead read",
    );
    ok(
      (await readAudit({ org: ORG, action: TASK_WAKE_RETARGET_ACTION })).length === retargetsBefore + 1,
      "§11c/AUDIT: the move wrote exactly one `unified.task_wake_retarget` row, so a re-point stays countable in production",
    );
  }
}

console.log(`✓ reply-delegation-pending: ${passed} assertions passed`);
