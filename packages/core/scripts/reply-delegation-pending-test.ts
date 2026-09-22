import { tmpdir } from "node:os";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { z } from "zod";
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
const { registerUnifiedWakeTarget, resolveUnifiedWakeTarget, mintWakeId } = await import("../agent/channels/unified-window.js");
const { unifiedSupervisorToken } = await import("../agent/channels/unified-supervisor.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { taskWakeId, TASK_WAKE_RETARGET_ACTION } = await import("../agent/channels/task-wake.js");
const { addressedWakeThisTurn, recordDeliveredWakes } = await import("../agent/access/dispatch-origin-signal.js");
const { recordRequesterIdentity } = await import("../agent/access/requester-identity.js");
const { consumeRepliedThisTurn } = await import("../agent/channels/reply-signal.js");
const { maybeRedrive } = await import("../agent/channels/unified-redrive.js");
const { DELEGATION_PENDING_REFUSAL_REASON, delegationPendingRefusalMessage } = await import("../agent/access/pending-delegation-signal.js");
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
  loadDomains: () => [defineDomain({ name: DOMAIN, reach: [SURFACE], ambientSupervisor: true, mode: "unified" })],
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

const hooks = (spawnTaint.default as unknown as { events: Record<string, (e: unknown, c: unknown) => Promise<void> | void> }).events;
const hook = hooks["action.result"]!;
const requestedHook = hooks["actions.requested"]!;

const receiptResult = (callId: string, taskId: string, agentId = "ag_agent:6666") => ({
  backgroundTask: { status: "working", taskId },
  callId,
  kind: "subagent-result",
  origin: "child",
  outcome: { kind: "parked", result: { kind: "succeeded", output: `Delegated as background task ${taskId} (working).` } },
  output: { agentId, status: "working", taskId },
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

async function dispatchReceipt(
  turnWake: string | undefined,
  turnId: string,
  callId: string,
  result: unknown,
  ctx: BindableContext,
): Promise<void> {
  if (turnWake !== undefined) {
    const envelope = `<wake wake-id="${turnWake}"><channel><message from="human" author-id="U1" trigger="true">delegate</message></channel></wake>`;
    recordDeliveredWakes(turnId, envelope);
    recordRequesterIdentity(ctx, turnId, envelope);
  }
  await requestedHook({ data: { actions: [{ kind: "subagent-call", callId, subagentName: "agent" }] } }, ctx);
  await hook({ data: { result } }, ctx);
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
  const binding = {
    org: ORG,
    platform: "slack" as const,
    workspace: "T1",
    surface: channelId,
    mode: "channel" as const,
    visibility: "public" as const,
    trust: "internal" as const,
    principalId: "U1",
    target: { channelId },
    ...(threadTs === undefined ? {} : { threadTs }),
  };
  await registerUnifiedWakeTarget(
    store,
    ORG,
    id,
    { platform: "slack", channelId, ...(threadTs === undefined ? {} : { threadTs }) },
    new Date().toISOString(),
    TOKEN,
    true,
    undefined,
    `slack/T1/${channelId}`,
    binding,
    { binding, requester: { kind: "requester", principalId: "U1" }, nonMemberWake: false },
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
    await dispatchReceipt(wAsk, "turn_696", "call_696a", receiptResult("call_696a", "task_696a"), ctxFor(wAsk, "turn_696"));
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
    await dispatchReceipt(wAsk, "turn_943", "call_943a", receiptResultV2("call_943a", "task_943a"), ctxFor(wAsk, "turn_943"));
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
    await dispatchReceipt(wOld, "turn_old", "call_696b", receiptResult("call_696b", "task_696b"), ctxFor(wOld, "turn_old"));
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
    await dispatchReceipt(wAsk, "turn_resid", "call_696c", receiptResult("call_696c", "task_696c"), ctxFor(wAsk, "turn_resid"));
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
ok(typeof unifiedAdapter["message.completed"] === "function", "🔴 §9 REACHABILITY: the unified channel really does register message.completed — the drop branch lives inside it");

const adapterCtx = { session: { continuation: { token: `unified:${TOKEN}` } } };
const completeWithProse = (text: string): Promise<void> =>
  unifiedAdapter["message.completed"]!({ finishReason: "stop", message: text }, adapterCtx);

function proseSession(turnWake: string, turnId: string): <T>(fn: () => Promise<T>) => Promise<T> {
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

function standingSession(): { setTurn: (turnWake: string, turnId: string) => void; inSession: <T>(fn: () => Promise<T>) => Promise<T> } {
  const c = new ContextContainer();
  const setTurn = (turnWake: string, turnId: string): void => {
    c.set(SessionKey, {
      sessionId: "reply-delegation-pending-test",
      auth: {
        current: {
          attributes: { oe_platform: "slack", oe_grain: "standing", oe_addressing: "direct-mention", oe_wake_id: turnWake, oe_window_token: TOKEN, channel_id: CHAN, team_id: "T1" },
          principalId: "U1",
          principalType: "slack-user",
        },
      },
      turn: { id: turnId, sequence: 1 },
      parent: undefined,
    });
  };
  return { setTurn, inSession: <T>(fn: () => Promise<T>): Promise<T> => contextStorage.run(c, fn) };
}

const answeredAt = async (wakeId: string): Promise<string | undefined> => (await store.getUnifiedWakeRecord(ORG, wakeId))?.answeredAt;

{
  {
    const wBridge = await wake("C_BRIDGE", "901.1");
    const before = posted.length;
    const inTurn = proseSession(wBridge, "turn_701");

    await inTurn(async () => {
      await dispatchReceipt(wBridge, "turn_701", "call_701a", receiptResult("call_701a", "task_701a"), ctxFor(wBridge, "turn_701"));

      const refused = await callReply(wBridge, "turn_701", wBridge, FABRICATION, true);
      ok(typeof refused.error === "string", "§9a precondition: the reply tool refuses the fabricated `done:true`");
      ok(posted.length === before, "§9a precondition: nothing posted through the tool");

      await completeWithProse(FABRICATION);
    });

    ok(
      posted.length === before,
      `🔴 §9a/ROOM: THE SECOND DOOR IS CLOSED (OPE-1982). The refused text reaches the room by NO route — the addressed-prose bridge that used to post it is deleted, so the count is unchanged (expected ${before}, saw ${posted.length})`,
    );
    ok(
      (await answeredAt(wBridge)) === undefined,
      "🔴 §9a THE FIX: the wake is NOT marked answered while the dispatched worker still owes it. This is the assertion OPE-701 exists for — pre-fix the bridge closed the wake the reply tool had just been stopped from closing",
    );

    const dropped9a = (await readAudit({ org: ORG, action: "turn.supervisor_prose_dropped" })).map((r) => (r.detail ?? {}) as Record<string, unknown>);
    const mine9a = dropped9a.filter((d) => d["wakeId"] === wBridge);
    ok(mine9a.length === 1, `🔴 §9a/AUDIT: the withheld answer is a ROW (expected 1 for this wake, saw ${mine9a.length})`);
    ok(mine9a[0]?.["addressing"] === "direct-mention", "🔴 §9a/AUDIT: …and it names the addressing, so an OWED answer that nobody received stays countable apart from an ambient drop");
    ok(!JSON.stringify(mine9a).includes("RECURRING.md"), "🔴 §9a/AUDIT: the prose never reaches the audit detail — the row records the decision, not the text");

    const wLater = await wake("C_LATER", "902.2");
    const landed = await proseSession(wLater, "turn_701_later")(() => callReply(wLater, "turn_701_later", wBridge, REAL_REFUSAL, true));
    ok(
      landed.posted === true,
      "🔴 §9a THE POINT: on a later turn the worker's real answer LANDS on the held wake through the fence's pending arm — the arm that refuses an answered wake. Without the fix this reply is refused as `answered` and the fabrication stands as the final word",
    );
    ok(posted.length === before + 1, "§9a/ROOM: the correction reached the room, and it is the ONLY thing this conversation heard");
    ok(typeof (await answeredAt(wBridge)) === "string", "§9a: …and THAT reply closes the wake normally, so the hold is a wait and not a leak");
  }

  {
    const wPlain = await wake("C_PROSE_PLAIN", "903.3");
    const before = posted.length;

    await proseSession(wPlain, "turn_701_plain")(() => completeWithProse("Here is the answer, retrieved and checked."));

    ok(posted.length === before, `🔴 §9b: an ORDINARY addressed turn's closing prose reaches the room by no route either (expected ${before}, saw ${posted.length})`);
    ok(
      (await answeredAt(wPlain)) === undefined,
      "🔴 §9b: …and the wake is NOT marked answered, so the one corrective redrive — or any later turn — can still put the answer in the room",
    );
    const closed = await proseSession(wPlain, "turn_701_plain_reply")(() => callReply(wPlain, "turn_701_plain_reply", wPlain, "The answer, this time through the tool.", true));
    ok(closed.posted === true, "§9b/CONTROL: the same wake accepts a `reply` tool call, so the drop above withheld a deliverable answer rather than naming a dead wake");
    ok(posted.length === before + 1, "§9b/CONTROL: …and THAT is what reaches the room — one post, through the tool");
    ok(typeof (await answeredAt(wPlain)) === "string", "§9b/CONTROL: …and the tool route closes the wake normally");
  }

  {
    const { NO_SUBSTANCE_DROP_REASON } = await import("../agent/channels/unified.js");
    const dropRows = async (): Promise<Record<string, unknown>[]> =>
      (await readAudit({ org: ORG, action: "turn.supervisor_prose_dropped" })).map((r) => (r.detail ?? {}) as Record<string, unknown>);

    const wStub = await wake("C_BRIDGE_STUB", "904.4");
    const before = posted.length;
    const dropsBefore = (await dropRows()).length;

    await proseSession(wStub, "turn_1911_stub")(() => completeWithProse("..."));

    ok(
      posted.length === before,
      `🔴 §9c THE FIX: a substance-free stub is NOT bridged — nothing reaches the room. Pre-fix the three characters posted AND closed the wake (expected ${before} posts, saw ${posted.length})`,
    );
    ok(
      (await answeredAt(wStub)) === undefined,
      "🔴 §9c: …and the wake stays ANSWERABLE, which is what lets a corrective turn — the auto-redrive's, or any later one — deliver a real answer into the same conversation. Pre-fix the mark closed that road",
    );
    const drops = await dropRows();
    ok(drops.length === dropsBefore + 1, `🔴 §9c/AUDIT REACHABILITY: the stub is a ROW, not an absence (expected ${dropsBefore + 1}, saw ${drops.length})`);
    const stubDrop = drops.filter((d) => d["wakeId"] === wStub);
    ok(stubDrop.length === 1, `🔴 §9c/AUDIT: exactly one row names the stub's wake (saw ${stubDrop.length})`);
    ok(
      stubDrop[0]?.["reason"] === NO_SUBSTANCE_DROP_REASON,
      "🔴 §9c/AUDIT: the row reads `no-substance` — the turn produced no answer to deliver, which is a different finding from `no-reply-call`, where the answer is in the dropped text",
    );
    ok(
      stubDrop[0]?.["addressing"] === "direct-mention",
      "§9c/AUDIT: …and the addressing still reads direct-mention, so a stub on an OWED answer stays countable apart from an ambient drop",
    );
  }

  {
    const { noteRoutineRunPermissionRefusal, carryRunRefusalsToRedrive } = await import("../agent/approvals/card-signal.js");
    const { RUN_REFUSAL_HEADING } = await import("../agent/routines/report.js");
    const { resetTurnClock } = await import("../agent/observability/turn-clock.js");

    const wFire = await wake("C_FIRE_REPORT", "905.5");
    const before = posted.length;
    const fireSeat = standingSession();

    fireSeat.setTurn(wFire, "turn_1982_fire");
    await fireSeat.inSession(async () => {
      resetTurnClock("turn_1982_fire", Date.now(), "reply-delegation-pending-test");
      noteRoutineRunPermissionRefusal({ permission: "use Notion", card: null, cardKnown: true, cardPosted: false, cardCapped: false });
      carryRunRefusalsToRedrive(wFire);
    });
    ok(posted.length === before, "§9d precondition: nothing has been posted on this wake yet");

    fireSeat.setTurn(wFire, "turn_1982_fire_corrected");
    const corrected = await fireSeat.inSession(() => {
      resetTurnClock("turn_1982_fire_corrected", Date.now(), "reply-delegation-pending-test");
      return callReply(wFire, "turn_1982_fire_corrected", wFire, "The digest is ready.", true);
    });
    ok(corrected.posted === true, "§9d: the corrective turn's reply posts");
    ok(posted.length === before + 1, "§9d/ROOM: …and it is the one thing this conversation heard");
    ok(
      posted[posted.length - 1]!.text.includes(RUN_REFUSAL_HEADING),
      `🔴 §9d THE GUARANTEE: the host's "could not do X" line rides the CORRECTIVE turn's post. Pre-carry the ledger was turn-keyed, the correction was a new turn, and the room never heard it (saw: ${JSON.stringify(posted[posted.length - 1]?.text.slice(0, 160))})`,
    );
    ok(posted[posted.length - 1]!.text.includes("use Notion"), "§9d: …naming the permission the run actually lost");

    const wPlain2 = await wake("C_FIRE_PLAIN", "906.6");
    const plainSeat = standingSession();
    plainSeat.setTurn(wPlain2, "turn_1982_plain");
    await plainSeat.inSession(async () => {
      resetTurnClock("turn_1982_plain", Date.now(), "reply-delegation-pending-test");
      carryRunRefusalsToRedrive(wPlain2);
    });
    plainSeat.setTurn(wPlain2, "turn_1982_plain_corrected");
    const plain = await plainSeat.inSession(() => {
      resetTurnClock("turn_1982_plain_corrected", Date.now(), "reply-delegation-pending-test");
      return callReply(wPlain2, "turn_1982_plain_corrected", wPlain2, "An ordinary answer.", true);
    });
    ok(plain.posted === true, "§9d/CONTROL precondition: the plain corrective reply posts");
    ok(!posted[posted.length - 1]!.text.includes(RUN_REFUSAL_HEADING), "🔴 §9d/NEGATIVE CONTROL: a corrective turn with nothing refused carries NO block — the heading is a finding, not boilerplate");
    ok(plainSeat !== fireSeat, "§9d/CONTROL: …on its own session container, so the control is not reading the fire's drained ledger");
  }

  {
    const { readFileSync } = await import("node:fs");
    const unifiedSrc = readFileSync(new URL("../agent/channels/unified.ts", import.meta.url), "utf8");
    ok(/carryRunRefusalsToRedrive\(wakeId\)/.test(unifiedSrc), "🔴 §9e: the drop branch HANDS the ledger to the correction");
    ok(/dropCarriedRunRefusals\(wakeId\)/.test(unifiedSrc), "🔴 §9e: …and DROPS it on every other outcome, so a correction that was never injected leaves nothing behind");
    ok(/carryRunRefusalsToRedrive\(wakeId\);[\s\S]{0,200}?await maybeRedrive\(/.test(unifiedSrc), "🔴 §9e: …and it carries BEFORE awaiting the re-injection, so the corrective turn can never consume ahead of the carry");
    ok(/route:\s*"bridge"/.test(unifiedSrc) === false, "§9e: …and the module still writes no retired bridge route");
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
      await dispatchReceipt(w, "turn_699a", "call_699a", receiptResult("call_699a", "task_699a"), ctxFor(w, "turn_699a"));
      const ack = await callReply(w, "turn_699a", w, HANDOFF, false);
      ok(ack.posted === true, "§10a precondition: the `done:false` hand-off posts");
      ok(
        typeof ack.note === "string" && ack.note.includes("has NOT reported yet"),
        "🔴 §10a/NOTE: the tool result tells the model its worker has not reported, so it knows it does not hold the answer",
      );
      ok(
        typeof ack.note === "string" && ack.note.includes("still working on it") && ack.note.includes("do not present what you have as the final result"),
        "🔴 §10a/NOTE: …and it instructs the model to SAY SO in its own words — the host adds no line of its own about the unfinished work, so an unwritten caveat is an unsaid one",
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
      await dispatchReceipt(w, "turn_1544a", "call_1544a", receiptResult("call_1544a", "task_1544a"), ctxFor(w, "turn_1544a"));
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
      await dispatchReceipt(w, "turn_699c", "call_699c", receiptResult("call_699c", "task_699c"), ctxFor(w, "turn_699c"));

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
    ok(!("PENDING_WORK_FRAME" in turnDelivery), "🔴 §10f: `turn-delivery` exports NO pending-work frame constant. OPE-1516 removed the host's line from the room; an export named here is that line coming back");
    ok(!("withPendingWorkFrame" in turnDelivery), "🔴 §10f: …and no `withPendingWorkFrame` helper either — the composition that applied it is gone, not merely unused");
    const labelled = withReplierPrefix("body", { taskLabel: "audit the ledger" });
    ok(labelled === "[audit the ledger] body", "🔴 §10f: the replier tier label is the host addition every reply carries — WHO is speaking, and nothing about what the message is");
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

  {
    const wTurn = await wake("C_706_TURN", "1101.1");
    const wSib = await wake("C_706_SIB", "1102.2");
    const before = posted.length;
    const addressedAtBridge: (string | undefined)[] = [];

    await proseSession(wTurn, "turn_706a")(async () => {
      await dispatchReceipt(wTurn, "turn_706a", "call_706a", receiptResult("call_706a", "task_706a"), ctxFor(wTurn, "turn_706a"));
      const refused = await callReply(wTurn, "turn_706a", wTurn, FABRICATION, true);
      ok(typeof refused.error === "string", "§11a precondition: the reply tool refuses the fabricated `done:true` — the refusal is what leaves `replied` false and opens the bridge");
      addressedAtBridge.push(addressedWakeThisTurn("turn_706a"));
      await completeWithProse(FABRICATION);
    });

    ok(addressedAtBridge.length === 1, "§11a: the turn body ran and took its reading");
    ok(
      addressedAtBridge[0] === undefined,
      `🔴 §11a THE STRUCTURAL PRECONDITION: a turn that reaches the bridge has addressed NOTHING, so the dispatch edge read \`currentWakeId\` and not an addressed wake (saw: ${JSON.stringify(addressedAtBridge[0])})`,
    );
    ok(posted.length === before, `§11a/ROOM: nothing posted — the closing prose is dropped on every addressing (OPE-1982), so the handoff below is read off the WAKE MAP and not off a post (expected ${before}, saw ${posted.length})`);
    ok(
      (await resolveUnifiedWakeTarget(store, ORG, wSib)) !== null,
      "§11a: the sibling wake is a LIVE registered wake on this same window — the task could have been pointed there, so the check below is not a strawman",
    );
    const reportsInto = await taskChannel("task_706a");
    const turnChannel = ((await resolveUnifiedWakeTarget(store, ORG, wTurn)) as { channelId?: string } | null)?.channelId;
    ok(
      reportsInto === turnChannel,
      `🔴 §11a THE HANDOFF: the worker will report into the SAME conversation this turn was woken for. There is no sibling to re-point, which is why the drop path needs no \`retargetTaskWakes\` call. If a change ever lets such a turn address a different wake, this assertion is what goes red (task reports into ${JSON.stringify(reportsInto)}, the turn's wake resolves to ${JSON.stringify(turnChannel)})`,
    );
    ok(reportsInto === "C_706_TURN", "§11a: …and that conversation is the turn's own, never the sibling");
    ok((await answeredAt(wTurn)) === undefined, "§11a: …and OPE-701's hold is intact — the wake stays answerable for the worker's real report");
  }

  {
    ok(
      (await maybeRedrive({ org: ORG, workspace: "w", wakeId: "any-wake", chars: 12, replied: true }, { store: store as never, reinject: null })).status === "skip-replied",
      "🔴 §11b: a turn whose reply tool POSTED is never corrected — the redrive reads `replied` and skips before it reads anything else",
    );
    ok(
      (await maybeRedrive({ org: ORG, workspace: "w", wakeId: "no-such-wake-11b", chars: 12, replied: false }, { store: store as never, reinject: null })).status !== "skip-replied",
      "§11b: …and a turn whose reply tool posted nothing gets past that gate, which is the state §11a runs in",
    );

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
      (await maybeRedrive({ org: ORG, workspace: "w", wakeId: w, chars: 12, replied: replied[0] ?? false }, { store: store as never, reinject: null })).status === "skip-replied",
      "🔴 §11b: …so no correction fires on a turn that has addressed a wake. §11a's `undefined` is therefore structural, not a property of its fixture",
    );
  }

  {
    const wAsk = await wake("C_706_ASK", "1104.4");
    const wOther = await wake("C_706_OTHER", "1105.5");
    const before = posted.length;
    const retargetsBefore = (await readAudit({ org: ORG, action: TASK_WAKE_RETARGET_ACTION })).length;

    await newSession()(async () => {
      await dispatchReceipt(wAsk, "turn_706c", "call_706c", receiptResult("call_706c", "task_706c"), ctxFor(wAsk, "turn_706c"));
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

{
  const { baseReplyEntry } = await import("../agent/tools/reply.js");
  const { registerSlackFixtureManifest } = await import("./_slack-test-stubs.js");
  registerSlackFixtureManifest();

  function baseCtxFor(turnId: string, threadTs: string): BindableContext {
    return {
      channel: { kind: "channel:slack" },
      session: {
        id: "reply-delegation-pending-test-base",
        turn: { id: turnId, sequence: 1 },
        auth: {
          current: {
            attributes: {
              oe_platform: "slack",
              oe_grain: "standing",
              channel_id: CHAN,
              channel_type: "channel",
              team_id: "T1",
              trust_checked: "true",
              thread_ts: threadTs,
            },
            principalId: "U1",
            principalType: "slack-user",
          },
        },
      },
      agent: { name: "oe", nodeId: "__root__" },
    } as unknown as BindableContext;
  }

  async function callBaseReply(turnId: string, threadTs: string, text: string): Promise<{ posted?: boolean; note?: string; error?: string }> {
    const ctx = baseCtxFor(turnId, threadTs);
    const armed = arm(ctx);
    if (!armed) return { error: "reply did not arm" };
    return armed
      .execute({ text }, ctx)
      .then((r) => r as { posted?: boolean; note?: string })
      .catch((e: unknown) => ({ error: String(e) }));
  }

  async function callBaseEdit(turnId: string, threadTs: string, messageId: string, text: string): Promise<{ edited?: boolean; note?: string; error?: string }> {
    const ctx = baseCtxFor(turnId, threadTs);
    const armed = armEdit(ctx);
    if (!armed) return { error: "edit_reply did not arm" };
    return armed
      .execute({ text, message_id: messageId }, ctx)
      .then((r) => r as { edited?: boolean; note?: string })
      .catch((e: unknown) => ({ error: String(e) }));
  }

  const lastPosted = (): string => posted[posted.length - 1]?.text ?? "";
  const HANDOFF = "I've handed this to a worker and will report back.";

  {
    const ctx = baseCtxFor("turn_1575_mount", "1201.0");
    ok(
      (arm(ctx) as unknown) === (baseReplyEntry as unknown),
      "🔴 §12f/PREMISE: this ctx mounts the PER-SURFACE `reply` entry — the legs below would silently measure the unified pair otherwise",
    );
    const armedEdit = armEdit(ctx) as unknown as { inputSchema?: { shape?: Record<string, unknown> } } | null;
    ok(armedEdit !== null, "§12f/PREMISE: `edit_reply` arms on a per-surface seat at all — it mounts on every surface, editable or not");
    ok(
      armedEdit?.inputSchema?.shape !== undefined && !("wake" in armedEdit.inputSchema.shape),
      "🔴 §12f/PREMISE: …and it is the PER-SURFACE edit entry — the unified one takes a `wake` argument, and this one takes none",
    );
  }

  {
    const inTurn = newSession();
    const before = posted.length;

    await inTurn(async () => {
      await dispatchReceipt(undefined, "turn_1575a", "call_1575a", receiptResult("call_1575a", "task_1575a"), baseCtxFor("turn_1575a", "1201.1"));
      const ack = await callBaseReply("turn_1575a", "1201.1", HANDOFF);
      ok(ack.posted === true, "§12a precondition: the per-surface hand-off posts");
      ok(
        typeof ack.note === "string" && ack.note.includes("has NOT reported yet"),
        "🔴 §12a/NOTE: the PER-SURFACE reply result tells the model its worker has not reported. Before OPE-1575 this door had no `note` field at all, so there was nowhere for the sentence to go",
      );
      ok(
        typeof ack.note === "string" && ack.note.includes("still working on it") && ack.note.includes("do not present what you have as the final result"),
        "🔴 §12a/NOTE: …and instructs it to SAY SO in its own words — one word, one meaning across all four doors",
      );
    });

    ok(posted.length === before + 1, "§12a/ROOM: exactly one message reached the room");
    ok(
      lastPosted() === HANDOFF,
      `🔴 §12a: the posted body is the model's text BYTE-IDENTICAL. The instruction rides the TOOL RESULT, never the room — a body longer than the model's text is a host line coming back (saw: ${JSON.stringify(lastPosted().slice(0, 120))})`,
    );
  }

  {
    const inTurn = newSession();
    const before = posted.length;
    const TEXT = "Here is the answer, retrieved and checked.";

    const plain = await inTurn(() => callBaseReply("turn_1575b", "1202.2", TEXT));
    ok(plain.posted === true, "§12b precondition: the ordinary per-surface answer posts");
    ok(posted.length === before + 1, "§12b/ROOM: one message reached the room");
    ok(lastPosted() === TEXT, "🔴 §12b NEGATIVE CONTROL: an ordinary per-surface reply is delivered BYTE-IDENTICAL to what the model wrote");
    ok(
      typeof plain.note === "string" && !plain.note.includes("has NOT reported yet"),
      "🔴 §12b: …and the note carries NO instruction on a turn that delegated nothing. Without this leg a door that appended the sentence to EVERY reply would pass §12a",
    );
    ok(
      typeof plain.note === "string" && plain.note.length > 0,
      "§12b: the note is still a sentence on an ordinary reply — the shared constant opens with a leading space and appends to one, so an empty note would render a stray space when the condition fires",
    );
  }

  {
    const inTurn = newSession();
    const before = posted.length;

    await inTurn(async () => {
      await dispatchReceipt(undefined, "turn_1575c", "call_1575c", receiptResult("call_1575c", "task_1575c"), baseCtxFor("turn_1575c", "1203.3"));
      const ack = await callBaseReply("turn_1575c", "1203.3", HANDOFF);
      ok(ack.posted === true, "§12c precondition: the hand-off posts, so there is an own post to edit");
      const edited = await callBaseEdit("turn_1575c", "1203.3", "ts-" + String(posted.length), "The hand-off, reworded.");
      ok(edited.edited === true, "§12c precondition: the per-surface edit lands — the message is ours, at this locus, inside the window");
      ok(
        typeof edited.note === "string" && edited.note.includes("has NOT reported yet"),
        "🔴 §12c/NOTE: the PER-SURFACE EDIT result tells the model its worker has not reported. This is the door that rewrites the very message carrying the caveat, and notifies nobody while it does",
      );
      ok(
        typeof edited.note === "string" && edited.note.includes("do not present what you have as the final result"),
        "🔴 §12c/NOTE: …and instructs it not to present what it has as the final result. Without this, editing the caveat away reds NOTHING",
      );
      ok(
        typeof edited.note === "string" && edited.note.includes("Nobody was notified"),
        "§12c/NOTE: …and the edit's own sentence is still there — the instruction is APPENDED to it, never a replacement for what the door already said",
      );
    });
    ok(posted.length === before + 1, "§12c/ROOM: the edit added no message to the room");
  }

  {
    const inTurn = newSession();
    await inTurn(async () => {
      const first = await callBaseReply("turn_1575d", "1204.4", "An ordinary answer.");
      ok(first.posted === true, "§12d precondition: the ordinary answer posts");
      const edited = await callBaseEdit("turn_1575d", "1204.4", "ts-" + String(posted.length), "An ordinary answer, corrected.");
      ok(edited.edited === true, "§12d precondition: the edit lands");
      ok(
        typeof edited.note === "string" && !edited.note.includes("has NOT reported yet"),
        "🔴 §12d NEGATIVE CONTROL: a per-surface turn with no pending worker gets NO instruction on the edit door either",
      );
    });
  }

  {
    const outputSchema = (baseReplyEntry as unknown as { outputSchema?: z.ZodTypeAny }).outputSchema;
    ok(outputSchema !== undefined, "§12e/PREMISE: the per-surface `reply` entry declares an output schema at all");
    const shape = (outputSchema as unknown as { shape?: Record<string, unknown> }).shape;
    ok(
      shape !== undefined && "note" in shape,
      "🔴 §12e: the per-surface `reply` DECLARES `note` on its output schema. An undeclared key is one the model may never be shown, so the instruction would ride nowhere",
    );

    const inTurn = newSession();
    const live = await inTurn(() => callBaseReply("turn_1575e", "1205.5", "A result to drive both schemas with."));
    ok(live.posted === true, "§12e/PREMISE: the call that produced the result under test really posted");

    const eveSchema = (await import(abs("dist/src/tools/schema.js"))) as {
      serializeOutputSchema(s: unknown): unknown;
      toOutputSchema(s: unknown): { readonly "~standard": { validate(v: unknown): { issues?: readonly unknown[] } } };
    };
    const rebuild = (s: unknown): { issues?: readonly unknown[] } =>
      eveSchema.toOutputSchema(eveSchema.serializeOutputSchema(s))["~standard"].validate(live);

    const replayedOld = rebuild(z.object({ posted: z.boolean(), id: z.string() }));
    ok(
      replayedOld.issues !== undefined && replayedOld.issues.length > 0,
      "🔴 §12e/REPLAY: the OLD schema, round-tripped the way eve replays one, REJECTS the new result. `serializeOutputSchema` emits `additionalProperties: false`, so the rebuilt schema is STRICT — it does not strip the third key, and any belief that it does is wrong about this pairing",
    );
    const replayedLive = rebuild(outputSchema as z.ZodTypeAny);
    ok(
      replayedLive.issues === undefined,
      "🔴 §12e/CONTROL: the LIVE schema round-trips and ACCEPTS the same result. Without this, a rejection from any cause at all would satisfy the assertion above",
    );

    const eveSrc = (rel: string): string => readFileSync(join(eveRoot, rel), "utf8");
    const dynamicToolBuild = eveSrc("dist/src/context/build-dynamic-tools.js");
    ok(
      dynamicToolBuild.includes("toOutputSchema") && dynamicToolBuild.includes("execute"),
      "🔴 §12e/CONTROL: eve's dynamic-tool REBUILD path still both attaches the output schema (`toOutputSchema`) and wires the tool's `execute` — so this reader is looking at the live code the tripwire below asserts about, not at a moved, split or emptied file",
    );
    ok(
      !/~standard|\.validate\(|safeParse|\.parse\(/.test(dynamicToolBuild),
      "🔴 §12e/TRIPWIRE: eve's dynamic-tool rebuild path names NO validation seam (`~standard`, `.validate(`, `safeParse`, `.parse(`), so the strict schema it attaches is never applied to a tool RESULT. This is the only reason the strict replay schema above is harmless — when it goes red, adding a key to a live tool's output schema is a breaking change for every in-flight session",
    );
  }

  {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const coreAgentRoot = join(repoRoot, "packages", "core", "agent");
    const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", ".turbo"]);
    const isGateScript = (rel: string): boolean => rel.split(sep).includes("scripts");
    const productFiles: string[] = [];
    const gateScriptFiles: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) walk(p);
        } else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) {
          const rel = relative(repoRoot, p);
          (isGateScript(rel) ? gateScriptFiles : productFiles).push(rel);
        }
      }
    };
    for (const root of [join(repoRoot, "packages"), join(repoRoot, "agent")]) walk(root);
    const SLACK_CHANNEL = join("packages", "providers", "slack", "agent", "channels", "slack.ts");
    ok(
      productFiles.includes(SLACK_CHANNEL),
      `🔴 §12g/CONTROL: the walk reached ${SLACK_CHANNEL}, the provider channel handler named above. A walk that misses it says nothing about the packages that import the writer through the exports map, and every assertion below would be vacuous`,
    );
    ok(
      gateScriptFiles.includes(relative(repoRoot, fileURLToPath(import.meta.url))),
      "§12g/CONTROL: the gate-script rule classifies THIS file as a gate script. Without a known member the rule could match nothing, and a product path would then be excluded by accident rather than by the stated rule",
    );

    const callSites: { readonly file: string; readonly count: number }[] = [];
    let declarations = 0;
    for (const rel of productFiles) {
      const src = readFileSync(join(repoRoot, rel), "utf8");
      const total = src.split("claimTasksForAddressedWake(").length - 1;
      if (total === 0) continue;
      const declared = src.split("export function claimTasksForAddressedWake(").length - 1;
      declarations += declared;
      if (total - declared > 0) callSites.push({ file: rel, count: total - declared });
    }
    ok(
      declarations === 1,
      `🔴 §12g/CONTROL: exactly ONE declaration of \`claimTasksForAddressedWake\` was found in the product tree (saw ${declarations}). Without this the count below could be zero because the reader or the name broke, not because the writer is unique`,
    );
    ok(
      callSites.length === 1 && callSites[0]?.file === join("packages", "core", "agent", "tools", "reply.ts") && callSites[0]?.count === 1,
      `🔴 §12g: \`claimTasksForAddressedWake\` is called from EXACTLY ONE site in the product tree, and that site is packages/core/agent/tools/reply.ts. Saw ${JSON.stringify(callSites)}. A second caller reachable from a per-surface turn sets \`addressed\`, arm 3 of \`pendingDelegationOwing\` then fails open on the probe, and the pending-work instruction silently stops reaching BOTH per-surface doors`,
    );

    const replySrc = readFileSync(join(coreAgentRoot, "tools", "reply.ts"), "utf8");
    const unifiedAt = replySrc.indexOf("export const unifiedReplyEntry");
    const baseAt = replySrc.indexOf("export const baseReplyEntry");
    const callAt = replySrc.indexOf("claimTasksForAddressedWake(");
    ok(
      unifiedAt >= 0 && baseAt > unifiedAt,
      "§12g/CONTROL: both reply entries were located, and the unified one is declared first — the offsets below only mean something if this holds",
    );
    ok(
      callAt > unifiedAt && callAt < baseAt,
      "🔴 §12g: the sole call sits inside `unifiedReplyEntry`, between its declaration and `baseReplyEntry`'s. Moved into the per-surface entry it would set `addressed` on exactly the turns arm 3 must not see it on",
    );
  }
}

{
  const events = (spawnTaint.default as unknown as { events: Record<string, (e: unknown, c: unknown) => Promise<void> | void> }).events;
  const turnStarted = events["turn.started"]!;
  const settlementWake = events["message.received"]!;
  const noReply = (await import("../agent/tools/no_reply.js")).default as unknown as {
    readonly execute: (i: Record<string, unknown>, c: unknown) => Promise<{ acknowledged?: boolean }>;
  };
  const { SETTLEMENT_REPORT_POSTED_ACTION, SETTLEMENT_REPORT_SKIPPED_ACTION, settlementReportOwedMessage } = await import(
    "../agent/access/pending-delegation-signal.js"
  );

  const settledNote = (taskId: string, result: string) => `Background task ${taskId} (agent) is completed.\n\nResult:\n${result}`;

  const callNoReply = async (turnWake: string, turnId: string): Promise<{ acknowledged?: boolean; error?: string }> =>
    noReply.execute({ reason: "nothing_to_add" }, ctxFor(turnWake, turnId)).catch((e: unknown) => ({ error: String(e) }));

  const rowsFor = async (action: string): Promise<Record<string, unknown>[]> =>
    (await readAudit({ org: ORG, action })).map((r) => (r.detail ?? {}) as Record<string, unknown>);

  const WORKER_RESULT = "The AWS identity is arn:aws:sts::111122223333:assumed-role/oe-readonly/session.";

  {
    const inTurn = newSession();
    const wAsk = await wake("C_1655", "222.1");
    const TASK = "task_1655aaaabbbb";

    await inTurn(async () => {
      await turnStarted({}, ctxFor(wAsk, "turn_1655_a"));
      await dispatchReceipt(wAsk, "turn_1655_a", "call_1655a", receiptResult("call_1655a", TASK), ctxFor(wAsk, "turn_1655_a"));
      const minted = await taskWakeId(ORG, TASK);
      ok(typeof minted === "string" && minted.length > 0, "§13a/REACHABILITY: the REAL dispatch hook minted the task's wake identity");
      const before = posted.length;
      const ack = await callReply(wAsk, "turn_1655_a", wAsk, "I've started the read-only AWS identity check; I'll report what it returns.", false);
      ok(ack.posted === true, "§13a: the hand-off note posts, exactly as §1 requires");
      ok(posted.length === before + 1, "§13a/ROOM: one message so far — the note");

      await turnStarted({}, ctxFor(wAsk, "turn_1655_b"));
      await settlementWake({ data: { message: settledNote(TASK, WORKER_RESULT) } }, ctxFor(wAsk, "turn_1655_b"));
      const wakeRows = await rowsFor("unified.task_wake");
      ok(
        wakeRows.some((d) => d.task === TASK && d.outcome === "installed"),
        "🔴 §13b/REACHABILITY: the settlement really installed the task's reply address on this turn. Every assertion below is about a turn that CAN post, so a run where the install missed would prove nothing",
      );

      const skippedBefore = (await rowsFor(SETTLEMENT_REPORT_SKIPPED_ACTION)).length;
      const quiet = await callNoReply(wAsk, "turn_1655_b");
      ok(
        typeof quiet.error === "string" && quiet.error.includes("the worker's report has now arrived"),
        "🔴 §13c: `no_reply` on the settlement turn is REFUSED, and the copy names what the turn owes. This is the exact move five a live run scenarios made",
      );
      ok(quiet.acknowledged !== true, "§13c: …and no silence was recorded");
      const skipped = await rowsFor(SETTLEMENT_REPORT_SKIPPED_ACTION);
      ok(
        skipped.length === skippedBefore + 1 && skipped[skipped.length - 1]?.task === TASK,
        "🔴 §13c/AUDIT: exactly one skipped row, naming the task whose report was owed — the habit stays countable in prod's actions-only posture",
      );
      ok(
        settlementReportOwedMessage().includes("`reply`"),
        "§13c/COPY: the refusal names the tool that keeps the promise. A refusal that teaches nothing ends the turn in silence",
      );

      const roomBefore = posted.length;
      const report = await callReply(wAsk, "turn_1655_b", wAsk, WORKER_RESULT, true);
      ok(report.posted === true, "🔴 §13d: the worker's result posts on the settlement turn");
      ok(posted.length === roomBefore + 1 && roomHas("assumed-role/oe-readonly"), "🔴 §13d/ROOM: the room received the worker's result, asserted on its content");
      const link = await rowsFor(SETTLEMENT_REPORT_POSTED_ACTION);
      ok(
        link.some((d) => d.task === TASK && d.wake === wAsk),
        "🔴 §13d/AUDIT: the settle → reply link — one row naming the task the settlement arrived for and the wake the report reached",
      );

    });
  }

  {
    const inTurn = newSession();
    const wAsk = await wake("C_1655E", "222.4");
    const TASK = "task_1655eeeeffff";
    await inTurn(async () => {
      await turnStarted({}, ctxFor(wAsk, "turn_1655_e1"));
      await dispatchReceipt(wAsk, "turn_1655_e1", "call_1655e", receiptResult("call_1655e", TASK), ctxFor(wAsk, "turn_1655_e1"));
      const ack = await callReply(wAsk, "turn_1655_e1", wAsk, "On it — I'll report what the worker finds.", false);
      ok(ack.posted === true, "§13e/SETUP: the hand-off note posted, so a report is promised");
      await turnStarted({}, ctxFor(wAsk, "turn_1655_e2"));
      await settlementWake({ data: { message: settledNote(TASK, WORKER_RESULT) } }, ctxFor(wAsk, "turn_1655_e2"));
      const report = await callReply(wAsk, "turn_1655_e2", wAsk, WORKER_RESULT, true);
      ok(report.posted === true, "§13e/SETUP: …and the report posted on the settlement turn");
      const quiet = await callNoReply(wAsk, "turn_1655_e2");
      ok(
        quiet.error === undefined,
        "🔴 §13e: the FIRST `no_reply` after the report is ACCEPTED — the post itself discharged the duty. This turn drew no earlier refusal, so the valve cannot be what let it through",
      );
    });
  }

  {
    const inTurn = newSession();
    const wAsk = await wake("C_1655H", "222.5");
    const wOther = await wake("C_1655H_OTHER", "222.6");
    const TASK = "task_1655hhhhiiii";
    await inTurn(async () => {
      await turnStarted({}, ctxFor(wAsk, "turn_1655_h1"));
      await dispatchReceipt(wAsk, "turn_1655_h1", "call_1655h", receiptResult("call_1655h", TASK), ctxFor(wAsk, "turn_1655_h1"));
      const ack = await callReply(wAsk, "turn_1655_h1", wAsk, "I've started it; I'll report back here.", false);
      ok(ack.posted === true, "§13h/SETUP: the hand-off note posted into conversation A");
      await turnStarted({}, ctxFor(wAsk, "turn_1655_h2"));
      await settlementWake({ data: { message: settledNote(TASK, WORKER_RESULT) } }, ctxFor(wAsk, "turn_1655_h2"));

      const linkBefore = (await rowsFor(SETTLEMENT_REPORT_POSTED_ACTION)).length;
      const sibling = await callReply(wAsk, "turn_1655_h2", wOther, "Answering your other question first.", true);
      ok(sibling.posted === true, "§13h: the answer to conversation B posts — the duty never silences a seat");
      ok(
        (await rowsFor(SETTLEMENT_REPORT_POSTED_ACTION)).length === linkBefore,
        "🔴 §13h: …and writes NO settle → reply row. A row naming B would assert that conversation A had been told, while A heard nothing",
      );
      const quiet = await callNoReply(wAsk, "turn_1655_h2");
      ok(
        typeof quiet.error === "string" && quiet.error.includes("the worker's report has now arrived"),
        "🔴 §13h: …and the duty is STILL armed — a post to a sibling conversation is not the report conversation A is waiting for",
      );
    });
  }

  {
    const inTurn = newSession();
    const wAsk = await wake("C_1655F", "222.2");
    const TASK = "task_1655ffffgggg";
    await inTurn(async () => {
      await turnStarted({}, ctxFor(wAsk, "turn_1655_f1"));
      await dispatchReceipt(wAsk, "turn_1655_f1", "call_1655f", receiptResult("call_1655f", TASK), ctxFor(wAsk, "turn_1655_f1"));
      const ack = await callReply(wAsk, "turn_1655_f1", wAsk, "Started it — I'll report back.", false);
      ok(ack.posted === true, "§13f/SETUP: the hand-off note posted, so a report is promised");
      await turnStarted({}, ctxFor(wAsk, "turn_1655_f2"));
      await settlementWake({ data: { message: settledNote(TASK, "nothing to report") } }, ctxFor(wAsk, "turn_1655_f2"));
      const first = await callNoReply(wAsk, "turn_1655_f2");
      ok(typeof first.error === "string", "§13f: the first silence is refused");
      const second = await callNoReply(wAsk, "turn_1655_f2");
      ok(
        second.error === undefined,
        "🔴 §13f: the SECOND call is accepted. This guard is a valve, not a wall — unlike the stand-down acknowledgement, a settlement report can be refused by a gate below the reply plane, so a turn with no move left must be able to end",
      );
    });
  }

  {
    const inTurn = newSession();
    const wAsk = await wake("C_1655G", "222.3");
    const TASK = "task_1655gggghhhh";
    await inTurn(async () => {
      await turnStarted({}, ctxFor(wAsk, "turn_1655_g1"));
      await dispatchReceipt(wAsk, "turn_1655_g1", "call_1655g", receiptResult("call_1655g", TASK), ctxFor(wAsk, "turn_1655_g1"));
      await turnStarted({}, ctxFor(wAsk, "turn_1655_g2"));
      await settlementWake({ data: { message: settledNote(TASK, "a chore finished") } }, ctxFor(wAsk, "turn_1655_g2"));
      const wakeRows = await rowsFor("unified.task_wake");
      ok(
        wakeRows.some((d) => d.task === TASK && d.outcome === "installed"),
        "§13g/CONTROL: the settlement installed the address here too — so the leg below differs from §13c only in the missing promise",
      );
      const quiet = await callNoReply(wAsk, "turn_1655_g2");
      ok(
        quiet.error === undefined,
        "🔴 §13g: a settlement the seat never announced leaves `no_reply` free. The PROMISE is the trigger, never the settlement",
      );
    });
  }
}

{
  const { TASK_FAILED_ACTION } = spawnTaint;
  const failedRows = async (): Promise<Record<string, unknown>[]> =>
    (await readAudit({ org: ORG, action: TASK_FAILED_ACTION })).map((r) => (r.detail ?? {}) as Record<string, unknown>);

  const failureResult = (callId: string, code: string, kind: string, message = "Read tool exited with status 1.") => ({
    callId,
    kind: "subagent-result",
    origin: "child",
    isError: true,
    outcome: { kind: "terminal", result: { error: { code, message }, kind } },
    output: { code, message },
    subagentName: "agent",
  });

  const inTurn = newSession();
  const wAsk = await wake("C_1654", "333.1");

  await inTurn(async () => {
    const before = (await failedRows()).length;
    await hook({ data: { result: failureResult("call_1654a", "SUBAGENT_EXECUTION_FAILED", "failed") } }, ctxFor(wAsk, "turn_1654_a"));
    const rows = await failedRows();
    ok(rows.length === before + 1, "🔴 §14a: a dead delegation writes EXACTLY ONE `delegation.task_failed` row. Before this it wrote none at all");
    const row = rows[rows.length - 1] ?? {};
    ok(row.call === "call_1654a", "§14a: …naming the call the seat made");
    ok(row.errorClass === "SUBAGENT_EXECUTION_FAILED", "🔴 §14a: …and the error class eve stamped, which is the string the shipper searched for and could not find");
    ok(row.error === "Read tool exited with status 1.", "🔴 §14a/OPE-1737: …and eve's own error TEXT, which is the field that DIAGNOSES. A class says a delegation died; only the message says why");
    ok(row.tool === "agent", "§14a: …and the tool, so an operator can see WHICH delegated read died");
    ok(row.turn === "turn_1654_a", "🔴 §14a: …and the seat's turn id, which is what joins this row to the transcript that explains it");
    ok(row.task === "", "§14a: the task id is EMPTY, and that is the honest answer — a delegation that died before it parked has no task to name");
    ok(row.outcome === "result", "🔴 §14a/OPE-1737: …and `outcome` names the EDGE that wrote the row — here eve's own result envelope");
    ok(row.status === "failed", "§14a: …with eve's own status word moved to `status`, where `failed` and `cancelled` still tell two events apart");
    ok(row.parse === "result", "§14a: …and `parse` says the fields came off that envelope, not off a notification text");

    await hook({ data: { result: failureResult("call_1654b", "AGENT_UNREACHABLE", "failed") } }, ctxFor(wAsk, "turn_1654_a"));
    const sibling = await failedRows();
    ok(
      sibling.some((d) => d.errorClass === "AGENT_UNREACHABLE"),
      "🔴 §14b: a SIBLING error class is recorded too — the discriminator is eve's `isError`, never the code",
    );

    const beforeOk = (await failedRows()).length;
    await dispatchReceipt(wAsk, "turn_1654_a", "call_1654c", receiptResult("call_1654c", "task_1654cccc"), ctxFor(wAsk, "turn_1654_a"));
    await hook(
      { data: { result: { callId: "call_1654d", kind: "subagent-result", origin: "child", outcome: { kind: "terminal", result: { kind: "succeeded", output: "done" } }, output: "done", subagentName: "agent" } } },
      ctxFor(wAsk, "turn_1654_a"),
    );
    ok((await failedRows()).length === beforeOk, "🔴 §14c/CONTROL: a parked receipt and a SUCCEEDED delegation return write no failure row at all");
  });

  {
    const events = (spawnTaint.default as unknown as { events: Record<string, (e: unknown, c: unknown) => Promise<void> | void> }).events;
    const turnStarted = events["turn.started"]!;
    const settlementWake = events["message.received"]!;

    const failedNote = (taskId: string, payload: string) => `Background task ${taskId} (agent) failed.\n\nError:\n${payload}`;

    const evePayload = (message: string, code = "SUBAGENT_EXECUTION_FAILED") => JSON.stringify({ code, message });

    const LIVE_ERROR = "Cannot read properties of undefined (reading 'push')";

    const settleTurn = newSession();
    const wSettle = await wake("C_1737", "444.1");

    await settleTurn(async () => {
      const TASK = "task_1737aaaabbbb";
      await turnStarted({}, ctxFor(wSettle, "turn_1737_d1"));
      await dispatchReceipt(wSettle, "turn_1737_d1", "call_1737d", receiptResult("call_1737d", TASK, "ag_agent:1737d"), ctxFor(wSettle, "turn_1737_d1"));
      const before = (await failedRows()).length;
      await turnStarted({}, ctxFor(wSettle, "turn_1737_d2"));
      await settlementWake({ data: { message: failedNote(TASK, evePayload(LIVE_ERROR)) } }, ctxFor(wSettle, "turn_1737_d2"));
      const rows = await failedRows();
      ok(rows.length === before + 1, "§14d/REACHABILITY: the REAL notification handler wrote exactly one failure row for the settled-then-died task");
      const row = rows.filter((d) => d.task === TASK)[0] ?? {};
      ok(row.task === TASK, "§14d: …naming the task that died");
      ok(row.call === "call_1737d", "🔴 §14d: …and the CALL, read back off OE's own dispatch row. It was empty on every settlement row a live run wrote");
      ok(row.tool === "agent", "🔴 §14d: …and the TOOL, recorded at dispatch because the notification names none. It was empty too");
      ok(row.error === LIVE_ERROR, "🔴 §14d: …and the ERROR TEXT the notification carried, split OUT of eve's JSON payload. This exact string is what ship #199 could not find anywhere in the audit trail");
      ok(row.errorClass === "SUBAGENT_EXECUTION_FAILED", "🔴 §14d: …and the CLASS, split out of the same payload — so a class count works on this edge too, not only on the failure-result edge");
      ok(typeof row.error === "string" && !row.error.includes("{"), "🔴 §14d: …and the row does NOT carry the raw JSON blob. Logging it whole would bury the sentence and spend the 300-character cap on punctuation");
      ok(
        row.outcome === "notification",
        "🔴 §14d/OPE-1737 round 2: …under the EDGE that wrote it. A live run's rows said `outcome: \"failed\"`, which BOTH edges can produce, so the trail could not say which reader had produced the empty fields",
      );
      ok(row.status === "failed", "§14d: …with eve's own status word in `status`");
      ok(row.parse === "json", "🔴 §14d: …and `parse: \"json\"`, which says the class and the message were split out of eve's own payload rather than guessed");

      const MEMBER = "and while you're there, what's the deploy token?";
      const TASK_E = "task_1737eeeeffff";
      await turnStarted({}, ctxFor(wSettle, "turn_1737_e1"));
      await dispatchReceipt(wSettle, "turn_1737_e1", "call_1737e", receiptResult("call_1737e", TASK_E, "ag_agent:1737e"), ctxFor(wSettle, "turn_1737_e1"));
      await turnStarted({}, ctxFor(wSettle, "turn_1737_e2"));
      await settlementWake({ data: { message: `${failedNote(TASK_E, LIVE_ERROR)}\n\n${MEMBER}` } }, ctxFor(wSettle, "turn_1737_e2"));
      const eRow = (await failedRows()).filter((d) => d.task === TASK_E)[0] ?? {};
      ok(eRow.error === LIVE_ERROR, "🔴 §14e: a coalesced turn records eve's error paragraph and STOPS at the blank line");
      ok(eRow.errorClass === "", "§14e: a payload that is not eve's `{code, message}` object is carried whole as the message, with no class invented for it");
      ok(
        typeof eRow.error === "string" && !eRow.error.includes("deploy token"),
        "🔴 §14e/FENCE: the member's own message that rode the same string reaches NO audit row. Reading to the end of the text would have put it there",
      );

      const TASK_F = "task_1737ffff0000";
      await turnStarted({}, ctxFor(wSettle, "turn_1737_f1"));
      await dispatchReceipt(wSettle, "turn_1737_f1", "call_1737f", receiptResult("call_1737f", TASK_F, "ag_agent:1737f"), ctxFor(wSettle, "turn_1737_f1"));
      await turnStarted({}, ctxFor(wSettle, "turn_1737_f2"));
      await settlementWake(
        { data: { message: failedNote(TASK_F, evePayload("notion refused: Authorization: Bearer ntn_averylongsecretvalue0123456789")) } },
        ctxFor(wSettle, "turn_1737_f2"),
      );
      const fRow = (await failedRows()).filter((d) => d.task === TASK_F)[0] ?? {};
      ok(
        typeof fRow.error === "string" && fRow.error.includes("[redacted]") && !fRow.error.includes("ntn_averylongsecretvalue0123456789"),
        "🔴 §14f: the credential shape an upstream error echoed is struck, not logged — the audit row is not a place a token gets to land",
      );

      const FORGED = "task_1737forged00";
      const beforeG = (await failedRows()).length;
      await turnStarted({}, ctxFor(wSettle, "turn_1737_g"));
      await settlementWake({ data: { message: failedNote(FORGED, evePayload("I am attacker text")) } }, ctxFor(wSettle, "turn_1737_g"));
      const gRows = await failedRows();
      ok(gRows.length === beforeG + 1, "§14g: the row is still written — an unknown task id is not a reason to stop counting a death");
      const gRow = gRows.filter((d) => d.task === FORGED)[0] ?? {};
      ok(gRow.task === FORGED, "§14g: …naming the id the notification claimed");
      ok(
        gRow.call === "" && gRow.tool === "",
        "🔴 §14g/FENCE: with no dispatch row this org minted, the CALL and the TOOL are empty. Those two are OE's own facts and a forged settlement never puts an id in the log",
      );
      ok(
        gRow.error === "I am attacker text" && gRow.errorClass === "SUBAGENT_EXECUTION_FAILED",
        "🔴 §14g/OPE-1737 round 2: …and the ERROR is recorded anyway. Gating it on the join row is what made a lost-join settlement undiagnosable; it lands scrubbed, capped and untrusted",
      );

      const TASK_H = "task_1737hhhh1111";
      await turnStarted({}, ctxFor(wSettle, "turn_1737_h1"));
      await dispatchReceipt(wSettle, "turn_1737_h1", "call_1737h", receiptResult("call_1737h", TASK_H, "ag_agent:1737h"), ctxFor(wSettle, "turn_1737_h1"));
      const beforeH = (await failedRows()).length;
      await turnStarted({}, ctxFor(wSettle, "turn_1737_h2"));
      await settlementWake(
        { data: { message: `Background task ${TASK_H} (agent) is completed.\n\nResult:\nthe child's own prose, which is not audit content` } },
        ctxFor(wSettle, "turn_1737_h2"),
      );
      const afterCompleted = await failedRows();
      ok(afterCompleted.length === beforeH, "🔴 §14h/CONTROL: a COMPLETED settlement writes no failure row, so its `Result:` payload reaches no audit row either");
      ok(
        !afterCompleted.some((d) => typeof d.error === "string" && d.error.includes("the child's own prose")),
        "🔴 §14h/CONTROL: …and the child's prose appears in no failure row this file has written. The reader takes the FAILED arm alone",
      );

      const TASK_I = "task_1737iiii2222";
      await turnStarted({}, ctxFor(wSettle, "turn_1737_i1"));
      await dispatchReceipt(wSettle, "turn_1737_i1", "call_1737i", receiptResult("call_1737i", TASK_I, "ag_agent:1737i"), ctxFor(wSettle, "turn_1737_i1"));
      const beforeI = (await failedRows()).length;
      await turnStarted({}, ctxFor(wSettle, "turn_1737_i2"));
      await settlementWake({ data: { message: `Background task ${TASK_I} (agent) is cancelled.` } }, ctxFor(wSettle, "turn_1737_i2"));
      ok((await failedRows()).length === beforeI, "🔴 §14h/CONTROL: a CANCELLED settlement is the deployment's own reaper, not a dead read — still no failure row");

      const TASK_J = "task_1737jjjj3333";
      await turnStarted({}, ctxFor(wSettle, "turn_1737_j1"));
      await dispatchReceipt(wSettle, "turn_1737_j1", "call_1737j", receiptResult("call_1737j", TASK_J, "ag_agent:1737j"), ctxFor(wSettle, "turn_1737_j1"));
      const beforeJ = (await failedRows()).length;
      await turnStarted({}, ctxFor(wSettle, "turn_1737_j2"));
      await settlementWake({ data: { message: `Background task ${TASK_J} (agent) failed.` } }, ctxFor(wSettle, "turn_1737_j2"));
      ok((await failedRows()).length === beforeJ + 1, "§14j/REACHABILITY: the real notification handler still wrote the failure row for a payload-less settlement");
      const jRow = (await failedRows()).filter((d) => d.task === TASK_J)[0] ?? {};
      ok(
        jRow.error === `Background task ${TASK_J} (agent) failed.`,
        `🔴 §14j: with no readable payload the row carries the NOTIFICATION ITSELF, never "". This is the field ship #201 found empty three times — got ${JSON.stringify(jRow.error)}`,
      );
      ok(jRow.parse === "raw", "🔴 §14j: …under `parse: \"raw\"`, which tells an operator the notification carried no readable payload rather than that the worker died quietly");
      ok(jRow.outcome === "notification", "§14j: …and `outcome` still names the notification edge, so the two facts are read together");
      ok(jRow.call === "call_1737j" && jRow.tool === "agent", "§14j: …while the call and the tool still come off OE's own dispatch row, which the missing payload does not touch");

      const TASK_K = "task_1737kkkk4444";
      await turnStarted({}, ctxFor(wSettle, "turn_1737_k1"));
      await dispatchReceipt(wSettle, "turn_1737_k1", "call_1737k", receiptResult("call_1737k", TASK_K, "ag_agent:1737k"), ctxFor(wSettle, "turn_1737_k1"));
      await turnStarted({}, ctxFor(wSettle, "turn_1737_k2"));
      await settlementWake({ data: { message: failedNote(TASK_K, JSON.stringify({ code: "ETIMEDOUT" })) } }, ctxFor(wSettle, "turn_1737_k2"));
      const kRow = (await failedRows()).filter((d) => d.task === TASK_K)[0] ?? {};
      ok(kRow.error === '{"code":"ETIMEDOUT"}', `🔴 §14k: a class-only payload still writes a non-empty \`error\` — got ${JSON.stringify(kRow.error)}`);
      ok(kRow.errorClass === "ETIMEDOUT", "§14k: …with the child's own class beside it");
      ok(kRow.parse === "text", "🔴 §14k: …under `parse: \"text\"`, never `json` — a `json` row claims BOTH halves read, and this one has no message");

      const TASK_L = "task_1737llll5555";
      await turnStarted({}, ctxFor(wSettle, "turn_1737_l1"));
      await dispatchReceipt(wSettle, "turn_1737_l1", "call_1737l", receiptResult("call_1737l", TASK_L, "ag_agent:1737l"), ctxFor(wSettle, "turn_1737_l1"));
      await turnStarted({}, ctxFor(wSettle, "turn_1737_l2"));
      await settlementWake(
        { data: { message: `Background task ${TASK_L} (agent) failed.\nAuthorization: Bearer ntn_averylongsecretvalue0123456789` } },
        ctxFor(wSettle, "turn_1737_l2"),
      );
      const lRow = (await failedRows()).filter((d) => d.task === TASK_L)[0] ?? {};
      ok(lRow.parse === "raw", "§14l: the payload-less notification takes the raw arm");
      ok(
        typeof lRow.error === "string" && lRow.error.includes("[redacted]") && !lRow.error.includes("ntn_averylongsecretvalue0123456789"),
        `🔴 §14l: …and the raw text is struck by the SAME audit redaction the JSON arm gets. The fallback is not a way past the scrub — got ${JSON.stringify(lRow.error)}`,
      );

      const TASK_M = "task_1737mmmm6666";
      await turnStarted({}, ctxFor(wSettle, "turn_1737_m1"));
      await dispatchReceipt(wSettle, "turn_1737_m1", "call_1737m", receiptResult("call_1737m", TASK_M, "ag_agent:1737m"), ctxFor(wSettle, "turn_1737_m1"));
      await turnStarted({}, ctxFor(wSettle, "turn_1737_m2"));
      await settlementWake(
        { data: { message: failedNote(TASK_M, JSON.stringify({ code: "Authorization: Bearer ntn_averylongsecretvalue0123456789", message: "the worker died" })) } },
        ctxFor(wSettle, "turn_1737_m2"),
      );
      const mRow = (await failedRows()).filter((d) => d.task === TASK_M)[0] ?? {};
      ok(mRow.error === "the worker died", "§14m: the message half is unaffected");
      ok(
        typeof mRow.errorClass === "string" && mRow.errorClass.includes("[redacted]") && !mRow.errorClass.includes("ntn_averylongsecretvalue0123456789"),
        `🔴 §14m: …and the CLASS is struck as well. The docs claim both fields are scrubbed; before this the class reached the row raw and unbounded — got ${JSON.stringify(mRow.errorClass)}`,
      );
    });
  }
}

console.log(`✓ reply-delegation-pending: ${passed} assertions passed`);
