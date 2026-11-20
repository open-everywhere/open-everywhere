// proves: REPLY-19

import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";
import { _dynamicResolverForTest } from "../agent/access/window-gated.js";
import { v27Hooks } from "./_hook-view.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const dir = join(tmpdir(), `open-everywhere-settlement-once-test-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
_setDeploymentIdentityForTest({ org: "acme", workspace: "dev" });

const { registerSlackTestBridge, registerSlackFixtureCodec, registerSlackFixtureMapper, registerSlackFixturePostArm } =
  await import("./_slack-test-stubs.js");
const { registerConfig } = await import("../agent/access/config.js");
const { defineDomain } = await import("../agent/memory/domain.js");
const { registerUnifiedWakeTarget, mintWakeId } = await import("../agent/channels/unified-window.js");
const { unifiedSupervisorToken } = await import("../agent/channels/unified-supervisor.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { registerPostArm } = await import("../agent/channels/post-arms.js");
const { tailWindowFor, seedTailWindow } = await import("../agent/channels/session-tail-record.js");
const { recordOwnPost } = await import("../agent/channels/own-post-ledger.js");
const { replyFoldTarget, refuseIfShouldFold, REPLY_FOLD_REFUSAL_REASON, REPLY_FOLD_FORCED_AUDIT_REASON } = await import("../agent/channels/reply-fold.js");
const { platformFailureClass } = await import("../agent/channels/platform-failure.js");
const { CredentialEndpointError } = await import("../agent/access/credential-endpoints.js");
const { SETTLEMENT_REPORT_POSTED_ACTION, SETTLEMENT_REPORT_SKIPPED_ACTION } = await import("../agent/access/pending-delegation-signal.js");
const hub = await import("../agent/hooks/delegation-settlement.js");
const { recordDeliveredWakes } = await import("../agent/access/dispatch-origin-signal.js");
const { recordRequesterIdentity } = await import("../agent/access/requester-identity.js");

type BindableContext = import("../agent/identity/binding.js").BindableContext;
type SessionTailEntry = import("../agent/channels/session-tail.js").SessionTailEntry;

const ORG = "acme";
const DOMAIN = "payments";
const CHAN = "C1";
const SURFACE = `slack/T1/${CHAN}`;
const TOKEN = unifiedSupervisorToken(DOMAIN, 1);
const rawTailWindow = tailWindowFor({ org: ORG, domainKey: DOMAIN, surfaceKey: SURFACE, rawToken: `unified:${TOKEN}`, platform: "slack" });
ok(rawTailWindow !== null, "fixture sanity: the window token classifies as a standing generation — every fold assertion below rests on this");
const TAIL_WINDOW = rawTailWindow as NonNullable<typeof rawTailWindow>;

const posted: { channel: string; text: string }[] = [];
const edited: { messageId: string; text: string }[] = [];

registerSlackTestBridge({
  channel: { __fixture: "slack" } as never,
  confirmChannelInternal: async () => true,
  form: async (method: string, body: string) => {
    const p = new URLSearchParams(body);
    if (method === "chat.postMessage") {
      posted.push({ channel: p.get("channel") ?? "", text: p.get("text") ?? "" });
      return { ok: true, ts: `ts-${posted.length}` } as never;
    }
    if (method === "chat.update") {
      edited.push({ messageId: p.get("ts") ?? "", text: p.get("text") ?? "" });
      return { ok: true, ts: p.get("ts") } as never;
    }
    return { ok: true } as never;
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
const noReplyTool = (await import("../agent/tools/no_reply.js")).default as unknown as {
  readonly execute: (i: Record<string, unknown>, c: unknown) => Promise<{ acknowledged?: boolean }>;
};
interface Armed {
  readonly execute: (input: Record<string, unknown>, ctx: unknown) => Promise<unknown>;
}
type Handler = (event: unknown, ctx: unknown) => unknown;
const armReply = (ctx: unknown): Armed | null => _dynamicResolverForTest(replyTool)({}, ctx) as Armed | null;

const hooks = v27Hooks(hub.default);
const startedHook = hooks.taskStarted;
const requestedHook = hooks.callRequested;
const turnStarted = hooks.turnStarted;
const settlementWake = hooks.taskCallSettled;

const settledNote = (taskId: string, result: string) => ({ callId: `call_${taskId}`, kind: "agent", name: "agent", output: result, status: "completed", taskId, turnId: "turn_settle" });
const receipt = (callId: string, taskId: string) => ({ callId, kind: "agent", name: "agent", taskId, turnId: "turn_dispatch" });

function ctxFor(turnWake: string, turnId: string): BindableContext {
  return {
    channel: { kind: "channel:unified", continuationToken: `unified:${TOKEN}` },
    session: {
      id: "settlement-once-test",
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

async function dispatchTask(turnWake: string, turnId: string, callId: string, taskId: string): Promise<void> {
  const ctx = ctxFor(turnWake, turnId);
  const envelope = `<wake wake-id="${turnWake}"><channel><message from="human" author-id="U1" trigger="true">delegate</message></channel></wake>`;
  recordDeliveredWakes(turnId, envelope);
  recordRequesterIdentity(ctx, turnId, envelope);
  await requestedHook({ data: { actions: [{ kind: "subagent-call", callId, subagentName: "agent" }] } }, ctx);
  await startedHook({ data: receipt(callId, taskId) }, ctx);
}

const nodeRequire = createRequire(import.meta.url);
const eveRoot = dirname(nodeRequire.resolve("eve/package.json"));
const absUrl = (rel: string): string => pathToFileURL(join(eveRoot, rel)).href;
const { ContextContainer, contextStorage } = await import(absUrl("dist/src/context/container.js"));
const { SessionKey } = await import(absUrl("dist/src/context/keys.js"));
function newSession(): <T>(fn: () => Promise<T>) => Promise<T> {
  const c = new ContextContainer();
  c.set(SessionKey, { sessionId: "settlement-once-test", auth: null, turn: 1, parent: undefined });
  return <T>(fn: () => Promise<T>): Promise<T> => contextStorage.run(c, fn);
}

async function callReply(
  turnWake: string,
  turnId: string,
  wake: string,
  text: string,
  done: boolean,
  force?: boolean,
): Promise<{ posted?: boolean; id?: string; note?: string; error?: string }> {
  const ctx = ctxFor(turnWake, turnId);
  const armed = armReply(ctx);
  if (!armed) return { error: "reply did not arm" };
  return armed
    .execute({ text, wake, done, ...(force === undefined ? {} : { force }) }, ctx)
    .then((r) => r as { posted?: boolean; id?: string; note?: string })
    .catch((e: unknown) => ({ error: String(e) }));
}

const callNoReply = async (turnWake: string, turnId: string, reason = "nothing_to_add"): Promise<{ acknowledged?: boolean; error?: string }> =>
  noReplyTool.execute({ reason }, ctxFor(turnWake, turnId)).catch((e: unknown) => ({ error: String(e) }));

async function wakeOn(channelId: string, threadTs: string): Promise<string> {
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
    threadTs,
  };
  await registerUnifiedWakeTarget(
    store,
    ORG,
    id,
    { platform: "slack", channelId, threadTs },
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

const detailsFor = async (action: string): Promise<Record<string, unknown>[]> =>
  (await readAudit({ org: ORG, action })).map((r) => (r.detail ?? {}) as Record<string, unknown>);
const reasonsFor = async (action: string): Promise<string[]> =>
  (await detailsFor(action)).map((d) => String(d.reason ?? ""));

const WORKER_RESULT = "The retry ceiling on the sandbox connector is 5, set in the payments bundle.";

const selfPost = (e: { readonly id: string; readonly wake: string; readonly platform?: string }): SessionTailEntry =>
  ({
    kind: "post",
    at: new Date().toISOString(),
    from: "self",
    trust: "principal",
    author: "x",
    platform: e.platform ?? "slack",
    container: SURFACE,
    text: "t",
    id: e.id,
    wake: e.wake,
  }) as unknown as SessionTailEntry;

{
  const inTurn = newSession();
  const wAsk = await wakeOn(CHAN, "928.1");
  const TASK = "agent-1753step28aa";
  await inTurn(async () => {
    seedTailWindow(TAIL_WINDOW);
    await turnStarted({}, ctxFor(wAsk, "turn_28_a"));
    await dispatchTask(wAsk, "turn_28_a", "call_28", TASK);
    const banner = await callReply(wAsk, "turn_28_a", wAsk, "I've started that check; I'll report what it returns.", false);
    ok(banner.posted === true, "§1/SETUP: the hand-off note posted, so a report is PROMISED");
    const roomAfterBanner = posted.length;

    await turnStarted({}, ctxFor(wAsk, "turn_28_b"));
    await settlementWake({ data: settledNote(TASK, WORKER_RESULT) }, ctxFor(wAsk, "turn_28_b"));
    ok(
      (await detailsFor("unified.task_wake")).some((d) => d.task === TASK && d.outcome === "installed"),
      "§1/REACHABILITY: the settlement installed the task's reply address, so this turn CAN post",
    );

    const wouldFold = await replyFoldTarget({ store, window: TAIL_WINDOW, platform: "slack", locus: { platform: "slack", channelId: CHAN }, answeringWake: wAsk });
    ok(
      wouldFold?.messageId === banner.id,
      "🔴 §1/REACHABILITY: the banner IS a live fold target on this turn — this is the 100%-by-construction condition, and without it every assertion below is vacuous",
    );

    const refusedBefore = (await reasonsFor("reply.refused")).length;
    const forcedBefore = (await reasonsFor("reply.forced")).length;
    const skippedBefore = (await detailsFor(SETTLEMENT_REPORT_SKIPPED_ACTION)).length;

    const report = await callReply(wAsk, "turn_28_b", wAsk, WORKER_RESULT, true);
    ok(report.posted === true, "🔴 §1: the report POSTS — it is new information and an edit would notify nobody");
    ok(posted.length === roomAfterBanner + 1, "🔴 §1/ROOM: exactly ONE new message reached the room");
    ok(posted[posted.length - 1]?.text.includes("retry ceiling"), "§1/ROOM: …and it carries the worker's result, asserted on content");
    ok(edited.length === 0, "🔴 §1/ROOM: NOTHING was edited — the banner still reads as the hand-off note it was");

    const refused = await reasonsFor("reply.refused");
    ok(refused.length === refusedBefore, "🔴 §1: NO refusal at all on the settlement turn");
    ok(!refused.slice(refusedBefore).includes(REPLY_FOLD_REFUSAL_REASON), `§1: specifically no \`${REPLY_FOLD_REFUSAL_REASON}\` — the policy did not apply`);
    const forced = await reasonsFor("reply.forced");
    ok(
      forced.length === forcedBefore,
      `🔴 §1: and NO \`reply.forced\` row either. The exemption is not a force — nothing was overridden, so a \`${REPLY_FOLD_FORCED_AUDIT_REASON}\` row would be a false record and would spend one of the turn's overrides`,
    );

    ok(
      (await detailsFor(SETTLEMENT_REPORT_POSTED_ACTION)).some((d) => d.task === TASK && d.wake === wAsk),
      "§1/AUDIT: the settle → reply link names the task and the wake the report reached",
    );
    const quiet = await callNoReply(wAsk, "turn_28_b");
    ok(quiet.error === undefined && quiet.acknowledged === true, "🔴 §1: the FIRST `no_reply` after the report is ACCEPTED — the valve is never reached");
    ok(
      (await detailsFor(SETTLEMENT_REPORT_SKIPPED_ACTION)).length === skippedBefore,
      "🔴 §1/AUDIT: and NO `settlement_report_skipped` row. On step 28 that row was written, the model was refused, and the duplicate followed three seconds later",
    );
    ok(posted.length === roomAfterBanner + 1, "🔴 §1/ROOM: still ONE message — the whole settlement added no second post");
  });
}

{
  const inTurn = newSession();
  const wAsk = await wakeOn(CHAN, "930.1");
  const TASK = "agent-1753widthcc";
  await inTurn(async () => {
    seedTailWindow(TAIL_WINDOW);
    await turnStarted({}, ctxFor(wAsk, "turn_w_a"));
    await dispatchTask(wAsk, "turn_w_a", "call_w", TASK);
    const banner = await callReply(wAsk, "turn_w_a", wAsk, "Started it — I'll report back.", false);
    ok(banner.posted === true, "§1b/SETUP: the hand-off note posted");
    await turnStarted({}, ctxFor(wAsk, "turn_w_b"));
    await settlementWake({ data: settledNote(TASK, WORKER_RESULT) }, ctxFor(wAsk, "turn_w_b"));

    const report = await callReply(wAsk, "turn_w_b", wAsk, WORKER_RESULT, false);
    ok(report.posted === true, "§1b/SETUP: the report posted under the exemption");
    ok(
      (await detailsFor(SETTLEMENT_REPORT_POSTED_ACTION)).some((d) => d.task === TASK),
      "§1b/SETUP: …and discharged the duty, which is the state the assertion below is about",
    );

    const roomBefore = posted.length;
    const second = await callReply(wAsk, "turn_w_b", wAsk, "One more thought on that.", false);
    ok(
      typeof second.error === "string" && second.error.includes("edit_reply"),
      "🔴 §1b: the NEXT post on the same settlement turn is an ordinary post again and meets the fold. The exemption covers the report, not the turn",
    );
    ok(posted.length === roomBefore, "🔴 §1b/ROOM: …and it posted nothing, so the room still holds one settlement message");
  });
}

{
  const ringOnly: SessionTailEntry[] = [selfPost({ id: "m-fold-1", wake: "wk-fold" })];
  const fakeStore = { readSessionTail: async (): Promise<SessionTailEntry[]> => ringOnly };
  await recordOwnPost(ORG, { platform: "slack", channelId: CHAN }, "m-fold-1");
  const args = {
    store: fakeStore,
    window: TAIL_WINDOW,
    platform: "slack",
    locus: { platform: "slack", channelId: CHAN },
    audit: { org: ORG, platform: "slack", workspace: "T1", surface: CHAN, route: "tool" as const },
    answeringWake: "wk-fold",
    ledgerDeps: { hasEventSeen: async () => true },
  };

  await newSession()(async () => {
    const refusedBefore = (await reasonsFor("reply.refused")).length;
    let threw = "";
    try {
      await refuseIfShouldFold({ ...args, turnId: "turn_fold_control" });
    } catch (e) {
      threw = String(e);
    }
    ok(threw.includes("edit_reply"), "🔴 §2/CONTROL: an ORDINARY post onto the seat's own last message is still refused and still steered to `edit_reply`");
    ok((await reasonsFor("reply.refused")).length === refusedBefore + 1, "§2/CONTROL: …and the refusal is recorded");

    const overrides = await refuseIfShouldFold({ ...args, turnId: "turn_fold_exempt", settlementReport: true });
    ok(overrides === 0, "🔴 §2: the SAME call marked as the settlement report returns 0 — no verdict, no override counted");
    ok((await reasonsFor("reply.refused")).length === refusedBefore + 1, "🔴 §2: …and writes no refusal row");
  });
}

{
  const inTurn = newSession();
  const wAsk = await wakeOn(CHAN, "929.1");
  const TASK = "agent-1753forcebb";
  await inTurn(async () => {
    seedTailWindow(TAIL_WINDOW);
    await turnStarted({}, ctxFor(wAsk, "turn_f_a"));
    await dispatchTask(wAsk, "turn_f_a", "call_f", TASK);
    const banner = await callReply(wAsk, "turn_f_a", wAsk, "On it — I'll report back.", false);
    ok(banner.posted === true, "§3/SETUP: the hand-off note posted");
    await turnStarted({}, ctxFor(wAsk, "turn_f_b"));
    await settlementWake({ data: settledNote(TASK, WORKER_RESULT) }, ctxFor(wAsk, "turn_f_b"));

    const forcedBefore = (await reasonsFor("reply.forced")).length;
    const report = await callReply(wAsk, "turn_f_b", wAsk, WORKER_RESULT, true);
    ok(report.posted === true, "🔴 §3: the report lands with NO `force` at all");
    ok((await reasonsFor("reply.forced")).length === forcedBefore, "🔴 §3: and no override was recorded — there was no verdict to override");
    ok(
      typeof report.note === "string" && !report.note.includes("You overrode a host verdict"),
      "🔴 §3: the note does not tell the seat it overrode anything. Two fold refusals are what drove the live model to blanket `force: true`, which disarms should-be-edit, stale-conversation AND answered-this-turn at once — the triple posts came from there",
    );
  });
}

{
  const ringOnly: SessionTailEntry[] = [selfPost({ id: "cmt-1", wake: "wk-notion", platform: "notion" })];
  const fakeStore = { readSessionTail: async (): Promise<SessionTailEntry[]> => ringOnly };
  const base = {
    store: fakeStore,
    window: TAIL_WINDOW,
    platform: "notion",
    locus: { platform: "notion", channelId: "ws_1753/page_1753" },
    answeringWake: "wk-notion",
    ledgerDeps: { hasEventSeen: async () => true },
  };
  let allowPatch = true;
  registerPostArm({
    platform: "notion",
    dispatchUnified: async () => "cmt-x",
    editMessage: async () => undefined,
    editReachable: async () => allowPatch,
  });

  allowPatch = true;
  ok(
    (await replyFoldTarget(base))?.messageId === "cmt-1",
    "§4/CONTROL: with PATCH inside the credential's methods, the Notion fold target resolves — so the leg below is about the METHODS and nothing else",
  );

  allowPatch = false;
  ok(
    (await replyFoldTarget(base)) === null,
    "🔴 §4: with the credential declaring GET,POST only, there is NO fold target. This deployment's Notion channel key really does declare GET,POST, so every edit the policy used to steer at was refused before a byte left",
  );

  registerPostArm({
    platform: "notion",
    dispatchUnified: async () => "cmt-x",
    editMessage: async () => undefined,
    editReachable: async () => {
      throw new Error("credential store down");
    },
  });
  ok(
    (await replyFoldTarget(base))?.messageId === "cmt-1",
    "🔴 §4/FAIL-OPEN: an arm that cannot decide does not get to refuse the fold — the pre-OPE-1753 answer stands",
  );

  registerPostArm({ platform: "notion", dispatchUnified: async () => "cmt-x", editMessage: async () => undefined });
  ok(
    (await replyFoldTarget(base))?.messageId === "cmt-1",
    "§4/CONTROL: presence is the declaration — an arm without the member is unchanged by this ticket",
  );
}

{
  ok(
    platformFailureClass(new CredentialEndpointError("refused")) === "definitive",
    "🔴 §5: the endpoint fence throws BEFORE any byte leaves, so nothing was sent. It used to class AMBIGUOUS, and the model was told 'the edit was sent but notion did not confirm it' — false in both halves",
  );
  ok(
    platformFailureClass(new Error("connection reset")) === "ambiguous",
    "§5/CONTROL: a bare transport error is still AMBIGUOUS — the classifier's fail-closed default is untouched",
  );
  ok(
    platformFailureClass(Object.assign(new Error("notion said no"), { status: 404 })) === "definitive",
    "§5/CONTROL: and a 4xx is still definitive by status, so §5 is not asserting a blanket verdict",
  );
}

{
  // §6: a step re-run that the workflow host reports as attempt 1 dispatches `task.started` again for
  // the same task start (the optimistic `step_started` path). The start edge claims the task start
  // once, so the second dispatch mints no second task wake. (For a re-run of the opening call,
  // `noteTaskStarted` writes no second start row even without the claim, so this section asserts on the
  // wake. §6b covers the continuation call, where the row does repeat.)
  const { taskWakeKey } = await import("../agent/channels/task-wake.js");
  const inTurn = newSession();
  const wAsk = await wakeOn(CHAN, "940.1");
  const TASK = "agent-2803rerun";
  const CALL = "call_2803";
  await inTurn(async () => {
    await turnStarted({}, ctxFor(wAsk, "turn_2803"));
    await dispatchTask(wAsk, "turn_2803", CALL, TASK);
    const first = await store.getTaskResult(ORG, taskWakeKey(TASK));
    ok(first !== undefined && first !== null, "§6/REACHABILITY: the first start minted the task's wake, so a second mint is visible");

    await startedHook({ data: receipt(CALL, TASK) }, ctxFor(wAsk, "turn_2803"));
    const second = await store.getTaskResult(ORG, taskWakeKey(TASK));
    ok(second === first, "🔴 §6: a second dispatch of one task start mints no second task wake — the start edge ran once");
  });
}

{
  // §6b: the same re-run for a continuation call. eve publishes `call.started` for the second call of an
  // open task. `noteTaskStarted` reads that call as a continuation, not a replay, so without the claim a
  // second dispatch writes a second `delegation.task_started` row.
  const { viewOf, ev } = await import("./_hook-view.js");
  const { TASK_STARTED_ACTION } = hub;
  const continuedHook = hooks.bound("call.started");
  const inTurn = newSession();
  const wAsk = await wakeOn(CHAN, "941.1");
  const TASK = "agent-2803cont";
  const TURN = "turn_2803b";
  await inTurn(async () => {
    await turnStarted({}, ctxFor(wAsk, TURN));
    await dispatchTask(wAsk, TURN, "call_2803_open", TASK);
    const view = viewOf([
      ev("session.started", {}),
      ev("turn.started", { turnId: TURN, cause: { policy: "test" }, follows: null }, { turnId: TURN }),
      ev("model.requested", { runId: "r1", owner: { turnId: TURN } }, { turnId: TURN, runId: "r1" }),
      ev("call.requested", { callId: "call_2803_open", owner: { runId: "r1" }, capability: { kind: "agent", name: "agent" } }, { turnId: TURN, runId: "r1" }),
      ev("task.started", { taskId: TASK, kind: "agent", name: "agent", startedBy: { callId: "call_2803_open" } }, { turnId: TURN }),
      ev("call.started", { callId: "call_2803_open", taskId: TASK }, { turnId: TURN }),
      ev("model.requested", { runId: "r2", owner: { turnId: TURN } }, { turnId: TURN, runId: "r2" }),
      ev("call.requested", { callId: "call_2803_cont", owner: { runId: "r2" }, capability: { kind: "agent", name: "agent" } }, { turnId: TURN, runId: "r2" }),
      ev("call.started", { callId: "call_2803_cont", taskId: TASK }, { turnId: TURN }),
    ]);
    const ctx = Object.assign(ctxFor(wAsk, TURN) as object, { view });
    const event = { type: "call.started", data: { callId: "call_2803_cont", taskId: TASK }, scope: { turnId: TURN } };
    const rows = async (): Promise<number> => {
      await new Promise((r) => setTimeout(r, 20));
      return (await detailsFor(TASK_STARTED_ACTION)).filter((d) => d.task === TASK && d.call === "call_2803_cont").length;
    };
    await continuedHook(event, ctx);
    const once = await rows();
    ok(once === 1, "§6b/REACHABILITY: the continuation call's first start wrote one start row");
    await continuedHook(event, ctx);
    ok((await rows()) === 1, "🔴 §6b: a second dispatch of one continuation start writes no second start row — the start edge ran once");
  });
}

// §6c–§6e: a step re-run in the turn state the re-run actually has. The dead attempt's writes to the eve
// session slots die with it, so each re-run below starts from a fresh session state, and the claim skips
// the start edge. The skipped edge re-arms the turn state from the durable rows. It also writes the
// durable rows that a dead first run did not write, each with the value the first run writes (§6d, §6g).
const { taskWakeKey } = await import("../agent/channels/task-wake.js");
const { pendingDelegationsOwing, delegationPendingRefusalMessage } = await import("../agent/access/pending-delegation-signal.js");
const { claimTasksForAddressedWake } = await import("../agent/access/dispatch-origin-signal.js");
const { liveTaskIds, treeIsDirty } = await import("../agent/hooks/settlement-flush.js");
const { outboundKey } = await import("../agent/operational/post-once.js");
const { taskCallLink } = await import("../agent/access/task-call-link.js");
const { generationOfTask, generationOwedTaskIds, generationOwedDelegation } = await import("../agent/channels/generation-retirement.js");
const { readTaskOpening } = await import("../agent/channels/task-provenance.js");
const owedCount = async (task: string): Promise<number> => (await generationOwedTaskIds(ORG, TOKEN)).filter((t) => t === task).length;
/** Waits for a first run to reach its kill point, and fails (never hangs) when it does not. */
const untilKilled = (start: (died: () => void) => void): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the first run never reached the kill point")), 5000);
    start(() => {
      clearTimeout(timer);
      resolve();
    });
  });
const rerunEnvelope = (wake: string): string => `<wake wake-id="${wake}"><channel><message from="human" author-id="U1" trigger="true">delegate</message></channel></wake>`;
async function enterTurn(wake: string, turnId: string): Promise<void> {
  await turnStarted({}, ctxFor(wake, turnId));
  recordDeliveredWakes(turnId, rerunEnvelope(wake));
  recordRequesterIdentity(ctxFor(wake, turnId), turnId, rerunEnvelope(wake));
}
const rowsOf = async (action: string, task: string): Promise<number> => {
  await new Promise((r) => setTimeout(r, 20));
  return (await detailsFor(action)).filter((d) => d.task === task).length;
};
const turnStateOf = (turnId: string, taskId: string, wake: string, addressed: string | undefined) => ({
  owing: pendingDelegationsOwing(turnId, wake, addressed),
  live: liveTaskIds().includes(taskId),
  dirty: treeIsDirty(),
});

{
  // §6c: the first run arms the turn state; a later continuation start of the same task overwrites the
  // task-wide wake row; the re-run of the FIRST start still re-arms its own wakes, read per call.
  const { TASK_STARTED_ACTION } = hub;
  const { viewOf, ev } = await import("./_hook-view.js");
  const continuedHook = hooks.bound("call.started");
  const wAsk = await wakeOn(CHAN, "942.1");
  const wLater = await wakeOn(CHAN, "942.5");
  const wOther = await wakeOn(CHAN, "942.9");
  const TASK = "agent-2815rerun";
  const CALL = "call_2815";
  const LATER = "call_2815_later";
  const TURN = "turn_2815";
  const state = () => turnStateOf(TURN, TASK, wAsk, wOther);

  let rowAfterFirst: string | null = null;
  let rowAfterLater: string | null = null;
  let firstState: ReturnType<typeof state> | undefined;
  let firstTasks: readonly { taskId: string; wakeId: string }[] = [];
  await newSession()(async () => {
    await turnStarted({}, ctxFor(wAsk, TURN));
    await dispatchTask(wAsk, TURN, CALL, TASK);
    rowAfterFirst = await store.getTaskResult(ORG, taskWakeKey(TASK));
    firstState = state();
    firstTasks = claimTasksForAddressedWake(TURN, wOther);
  });
  const mintedWake = rowAfterFirst === null ? undefined : (JSON.parse(rowAfterFirst) as { wakeId?: string }).wakeId;
  ok(typeof mintedWake === "string" && mintedWake.length > 0, "§6c/REACHABILITY: the first run minted the task's wake");
  ok(
    JSON.stringify(firstState) === JSON.stringify({ owing: [TASK], live: true, dirty: true }),
    `§6c/CONTROL: the first run arms the pending delegation ONCE, under its dispatch wake, with the live task and the dirty tree (got ${JSON.stringify(firstState)})`,
  );
  ok(
    JSON.stringify(firstTasks) === JSON.stringify([{ taskId: TASK, wakeId: mintedWake }]),
    `§6c/CONTROL: the first run notes the minted task wake once for the turn (got ${JSON.stringify(firstTasks)})`,
  );
  ok((await rowsOf(TASK_STARTED_ACTION, TASK)) === 1, "§6c/CONTROL: the first run writes ONE start row");

  // A later turn continues the task from another wake. Its start overwrites the task-wide wake row.
  const LATER_TURN = "turn_2815_later";
  await newSession()(async () => {
    await enterTurn(wLater, LATER_TURN);
    await requestedHook({ data: { actions: [{ kind: "subagent-call", callId: LATER, subagentName: "agent" }] } }, ctxFor(wLater, LATER_TURN));
    const view = viewOf([
      ev("session.started", {}),
      ev("turn.started", { turnId: TURN, cause: { policy: "test" }, follows: null }, { turnId: TURN }),
      ev("model.requested", { runId: "r8", owner: { turnId: TURN } }, { turnId: TURN, runId: "r8" }),
      ev("call.requested", { callId: CALL, owner: { runId: "r8" }, capability: { kind: "agent", name: "agent" } }, { turnId: TURN, runId: "r8" }),
      ev("task.started", { taskId: TASK, kind: "agent", name: "agent", startedBy: { callId: CALL } }, { turnId: TURN }),
      ev("call.started", { callId: CALL, taskId: TASK }, { turnId: TURN }),
      ev("turn.started", { turnId: LATER_TURN, cause: { policy: "test" }, follows: null }, { turnId: LATER_TURN }),
      ev("model.requested", { runId: "r9", owner: { turnId: LATER_TURN } }, { turnId: LATER_TURN, runId: "r9" }),
      ev("call.requested", { callId: LATER, owner: { runId: "r9" }, capability: { kind: "agent", name: "agent" } }, { turnId: LATER_TURN, runId: "r9" }),
      ev("call.started", { callId: LATER, taskId: TASK }, { turnId: LATER_TURN }),
    ]);
    await continuedHook({ type: "call.started", data: { callId: LATER, taskId: TASK }, scope: { turnId: LATER_TURN } }, Object.assign(ctxFor(wLater, LATER_TURN) as object, { view }));
    rowAfterLater = await store.getTaskResult(ORG, taskWakeKey(TASK));
  });
  const laterRow = rowAfterLater === null ? undefined : (JSON.parse(rowAfterLater) as { wakeId?: string; callId?: string });
  ok(
    laterRow?.callId === LATER && laterRow.wakeId !== mintedWake,
    `§6c/REACHABILITY: the later start overwrote the task-wide wake row, so a per-task read-back would name the wrong call (got ${JSON.stringify(laterRow)})`,
  );

  await newSession()(async () => {
    await enterTurn(wAsk, TURN);
    ok(
      JSON.stringify(state()) === JSON.stringify({ owing: [], live: false, dirty: false }),
      "§6c/SETUP: the re-run starts from a session state with no trace of the first run's turn state",
    );
    await startedHook({ data: receipt(CALL, TASK) }, ctxFor(wAsk, TURN));
    ok((await store.getTaskResult(ORG, taskWakeKey(TASK))) === rowAfterLater, "🔴 §6c: the re-run mints no wake and rewrites no wake row — the claim still holds the durable edge");
    ok((await rowsOf(TASK_STARTED_ACTION, TASK)) === 2, "§6c: …and writes no start row beyond the two starts (the first start and the later continuation)");
    const rerun = state();
    ok(
      JSON.stringify(rerun.owing) === JSON.stringify([TASK]),
      `🔴 §6c: the re-run turn holds the pending delegation under its OWN dispatch wake, so the reply gate and the closeout see the task (got ${JSON.stringify(rerun.owing)})`,
    );
    ok(rerun.live && rerun.dirty, "🔴 §6c: the re-run turn arms the live task and marks the tree dirty, so the settlement flush holds for it");
    const refused = await callReply(wAsk, TURN, wAsk, "The retry ceiling is 5.", true);
    ok(
      refused.error?.includes(delegationPendingRefusalMessage()) === true,
      `🔴 §6c: a final \`reply\` in the re-run turn is refused with \`delegation-pending\` (got ${JSON.stringify(refused).slice(0, 160)})`,
    );
    const rerunTasks = claimTasksForAddressedWake(TURN, wOther);
    ok(
      JSON.stringify(rerunTasks) === JSON.stringify([{ taskId: TASK, wakeId: mintedWake }]),
      `🔴 §6c: the re-run turn notes the first start's OWN minted wake, read back per call (got ${JSON.stringify(rerunTasks)})`,
    );
  });
}

{
  // §6d: the first run died after the claim and before it advanced the call's authority. The claim key is
  // held, the authority row still names the dispatch wake, and no wake was minted for the task. The re-run
  // arms the pending delegation under the dispatch wake and notes no minted wake.
  const { TASK_STARTED_ACTION } = hub;
  const wAsk = await wakeOn(CHAN, "943.1");
  const wOther = await wakeOn(CHAN, "943.9");
  const TASK = "agent-2815died";
  const CALL = "call_2815_died";
  const TURN = "turn_2815d";
  await store.deleteTaskResult(ORG, `oe-gen-owes:${TOKEN}`);
  await newSession()(async () => {
    await enterTurn(wAsk, TURN);
    await requestedHook({ data: { actions: [{ kind: "subagent-call", callId: CALL, subagentName: "agent" }] } }, ctxFor(wAsk, TURN));
    const claimKey = outboundKey({ surface: "delegation", action: "task.start", stableId: `${TASK}:${CALL}`, payload: "settlement-once-test" });
    ok(await store.markEventSeen(ORG, claimKey, new Date().toISOString(), 60 * 60 * 1000), "§6d/SETUP: the dead first run holds the start claim");
    await startedHook({ data: receipt(CALL, TASK) }, ctxFor(wAsk, TURN));
    ok((await store.getTaskResult(ORG, taskWakeKey(TASK))) === null, "§6d: the claim held — the re-run minted no task wake");
    ok(
      (await rowsOf(TASK_STARTED_ACTION, TASK)) === 1 && (await taskCallLink(ORG, TASK))?.callId === CALL,
      "🔴 §6d: the re-run writes the call link and the ONE start row that the dead first run owed, so the settlement reads the task's child session",
    );
    ok((await readTaskOpening(ORG, "settlement-once-test", TASK))?.openingCallId === CALL, "🔴 §6d: …the task's opening, under the dispatch wake");
    ok(
      (await generationOfTask(ORG, TASK)) === TOKEN && (await owedCount(TASK)) === 1,
      `🔴 §6d: …and the record that the seat's generation owes the task (generation ${String(await generationOfTask(ORG, TASK))}, owed ${await owedCount(TASK)})`,
    );
    const rerun = turnStateOf(TURN, TASK, wAsk, wOther);
    ok(
      JSON.stringify(rerun) === JSON.stringify({ owing: [TASK], live: true, dirty: true }),
      `🔴 §6d: the re-run arms the pending delegation under the dispatch wake the authority row still names (got ${JSON.stringify(rerun)})`,
    );
    const tasks = claimTasksForAddressedWake(TURN, wOther);
    ok(tasks.length === 0, `🔴 §6d: …and notes no minted wake, because the first run minted none that the task uses (got ${JSON.stringify(tasks)})`);
  });
}

{
  // §6e: a unified window with no dispatch authority. The first run arms nothing (the edge refuses the
  // dispatch), and the re-run that the claim skips arms nothing either.
  const { DISPATCH_UNAUTHORIZED_ACTION } = hub;
  const wAsk = await wakeOn(CHAN, "944.1");
  const TASK = "agent-2815noauth";
  const CALL = "call_2815_noauth";
  const TURN = "turn_2815e";
  const run = (): Promise<ReturnType<typeof turnStateOf>> =>
    newSession()(async () => {
      await enterTurn(wAsk, TURN);
      await startedHook({ data: receipt(CALL, TASK) }, ctxFor(wAsk, TURN));
      return turnStateOf(TURN, TASK, wAsk, undefined);
    });
  const first = await run();
  ok((await rowsOf(DISPATCH_UNAUTHORIZED_ACTION, TASK)) === 1, "§6e/REACHABILITY: the first run reached the edge and refused the dispatch");
  ok(JSON.stringify(first) === JSON.stringify({ owing: [], live: false, dirty: false }), `§6e/CONTROL: the first run arms no turn state (got ${JSON.stringify(first)})`);
  const rerun = await run();
  ok((await rowsOf(DISPATCH_UNAUTHORIZED_ACTION, TASK)) === 1, "§6e: the claim held — the re-run did not run the edge again");
  ok(JSON.stringify(rerun) === JSON.stringify({ owing: [], live: false, dirty: false }), `🔴 §6e: the re-run arms no turn state either, as the first run did (got ${JSON.stringify(rerun)})`);
}

{
  // §6f: the re-run cannot read the call's start-wake row (the store read fails). A failed read proves
  // neither "advanced" nor "not advanced", so the re-run arms no pending delegation. It must not fall back
  // to the authority row, which the first run's advance already pointed at the minted wake.
  const wAsk = await wakeOn(CHAN, "945.1");
  const TASK = "agent-2815unread";
  const CALL = "call_2815_unread";
  const TURN = "turn_2815f";
  await newSession()(async () => {
    await turnStarted({}, ctxFor(wAsk, TURN));
    await dispatchTask(wAsk, TURN, CALL, TASK);
    ok(JSON.stringify(turnStateOf(TURN, TASK, wAsk, undefined).owing) === JSON.stringify([TASK]), "§6f/CONTROL: the first run arms the pending delegation");
  });
  const live = store as unknown as { getTaskResult: (...a: unknown[]) => Promise<unknown> };
  const get = live.getTaskResult;
  let failedReads = 0;
  live.getTaskResult = async function (this: unknown, ...a: unknown[]) {
    if (typeof a[1] === "string" && a[1].startsWith("oe-task-start-wake:")) {
      failedReads++;
      throw new Error("the store read failed");
    }
    return await get.apply(this, a);
  };
  try {
    const rerun = await newSession()(async () => {
      await enterTurn(wAsk, TURN);
      await startedHook({ data: receipt(CALL, TASK) }, ctxFor(wAsk, TURN));
      return turnStateOf(TURN, TASK, wAsk, undefined);
    });
    ok(failedReads === 1, `§6f/REACHABILITY: the re-run reached the start-wake read, and it failed (reads: ${failedReads})`);
    ok(
      JSON.stringify(rerun) === JSON.stringify({ owing: [], live: false, dirty: false }),
      `🔴 §6f: a failed read arms no pending delegation under a wake it cannot prove (got ${JSON.stringify(rerun)})`,
    );
  } finally {
    live.getTaskResult = get;
  }
}

// §6g–§6h: the durable half of a re-run (OPE-2819). A first run that dies after the claim and before
// `noteGenerationDelegation` leaves no record that the seat's generation owes the task, so the OPE-1620
// guard can retire that generation while the task is still live. The re-run that the claim skips writes
// the record, exactly once. The kill is a store read that never returns: the first run stops at the
// record's first read, as a dead process stops, and its promise is abandoned.
const GEN_KEYS = ["oe-gen-owes:", "oe-task-gen:"];
const genWrites = { count: 0 };
const liveStore = store as unknown as {
  getTaskResult: (...a: unknown[]) => Promise<unknown>;
  putTaskResult: (...a: unknown[]) => Promise<unknown>;
};
const realGet = liveStore.getTaskResult;
const realPut = liveStore.putTaskResult;
let killAtRecord: (() => void) | undefined;
liveStore.getTaskResult = function (this: unknown, ...a: unknown[]) {
  if (killAtRecord !== undefined && typeof a[1] === "string" && a[1].startsWith("oe-gen-owes:")) {
    const died = killAtRecord;
    killAtRecord = undefined;
    died();
    return new Promise<never>(() => undefined);
  }
  return realGet.apply(this, a);
};
liveStore.putTaskResult = function (this: unknown, ...a: unknown[]) {
  if (typeof a[1] === "string" && GEN_KEYS.some((k) => (a[1] as string).startsWith(k))) genWrites.count++;
  return realPut.apply(this, a);
};

{
  // §6g: the first run dies between the claim and the owed-generation record.
  await store.deleteTaskResult(ORG, `oe-gen-owes:${TOKEN}`);
  const wAsk = await wakeOn(CHAN, "946.1");
  const TASK = "agent-2819died";
  const CALL = "call_2819_died";
  const TURN = "turn_2819";
  let rowAfterFirst: string | null = null;
  await untilKilled((died) => {
    killAtRecord = died;
    void newSession()(async () => {
      await turnStarted({}, ctxFor(wAsk, TURN));
      await dispatchTask(wAsk, TURN, CALL, TASK);
    });
  });
  rowAfterFirst = await store.getTaskResult(ORG, taskWakeKey(TASK));
  ok(rowAfterFirst !== null, "§6g/REACHABILITY: the first run passed the claim and minted the task's wake before it died");
  ok(
    (await generationOfTask(ORG, TASK)) === undefined && (await owedCount(TASK)) === 0,
    "§6g/REACHABILITY: the first run died before it wrote the owed-generation record",
  );
  const writesBefore = genWrites.count;
  const rerun = await newSession()(async () => {
    await enterTurn(wAsk, TURN);
    await startedHook({ data: receipt(CALL, TASK) }, ctxFor(wAsk, TURN));
    return turnStateOf(TURN, TASK, wAsk, undefined);
  });
  ok((await store.getTaskResult(ORG, taskWakeKey(TASK))) === rowAfterFirst, "§6g: the claim held — the re-run minted no second task wake");
  ok(JSON.stringify(rerun) === JSON.stringify({ owing: [TASK], live: true, dirty: true }), `§6g: the re-run re-arms the turn state (got ${JSON.stringify(rerun)})`);
  ok(
    (await generationOfTask(ORG, TASK)) === TOKEN && (await owedCount(TASK)) === 1,
    `🔴 §6g: the re-run writes the record that the seat's generation owes the task (generation ${String(await generationOfTask(ORG, TASK))}, owed ${await owedCount(TASK)})`,
  );
  ok((await generationOwedDelegation(ORG, TOKEN)) === "owed", "🔴 §6g: …so the retirement guard reads the generation as owing a live delegation");
  ok(genWrites.count - writesBefore === 2, `§6g: the repair writes the owed list and the task's generation row once each (writes: ${genWrites.count - writesBefore})`);
  const writesAfterRepair = genWrites.count;
  await newSession()(async () => {
    await enterTurn(wAsk, TURN);
    await startedHook({ data: receipt(CALL, TASK) }, ctxFor(wAsk, TURN));
  });
  ok(
    genWrites.count === writesAfterRepair && (await owedCount(TASK)) === 1,
    `🔴 §6g: a second re-run writes the record no second time (writes: ${genWrites.count - writesAfterRepair}, owed ${await owedCount(TASK)})`,
  );
}

{
  // §6h: the negative control. A clean first run writes the record once, and a re-run writes nothing to it.
  await store.deleteTaskResult(ORG, `oe-gen-owes:${TOKEN}`);
  const wAsk = await wakeOn(CHAN, "947.1");
  const TASK = "agent-2819clean";
  const CALL = "call_2819_clean";
  const TURN = "turn_2819h";
  const before = genWrites.count;
  await newSession()(async () => {
    await turnStarted({}, ctxFor(wAsk, TURN));
    await dispatchTask(wAsk, TURN, CALL, TASK);
  });
  ok(
    genWrites.count - before === 2 && (await owedCount(TASK)) === 1 && (await generationOfTask(ORG, TASK)) === TOKEN,
    `§6h/CONTROL: a clean first run writes the record once (writes: ${genWrites.count - before}, owed ${await owedCount(TASK)})`,
  );
  const afterFirst = genWrites.count;
  const rerun = await newSession()(async () => {
    await enterTurn(wAsk, TURN);
    await startedHook({ data: receipt(CALL, TASK) }, ctxFor(wAsk, TURN));
    return turnStateOf(TURN, TASK, wAsk, undefined);
  });
  ok(JSON.stringify(rerun.owing) === JSON.stringify([TASK]), "§6h/CONTROL: the re-run reached the re-arm");
  ok(
    genWrites.count === afterFirst && (await owedCount(TASK)) === 1,
    `🔴 §6h: the re-run after a clean first run writes the record no second time (writes: ${genWrites.count - afterFirst})`,
  );
}
{
  // §6i: a continuation call's claim row. The continuation's commit writes this turn's claim, and the start
  // edge marks it dispatched with the call. A re-run after a clean first run writes the claim row no second
  // time. A first run that died before the mark leaves the commit's claim, and the re-run marks it.
  const { viewOf, ev } = await import("./_hook-view.js");
  const continuedHook = hooks.bound("call.started");
  const wAsk = await wakeOn(CHAN, "948.1");
  const wLater = await wakeOn(CHAN, "948.5");
  const TASK = "agent-2819claim";
  const OPEN = "call_2819_open";
  const CONT = "call_2819_cont";
  const TURN = "turn_2819i";
  const LATER_TURN = "turn_2819i_later";
  const claimKey = `oe-task-claim:settlement-once-test:${TASK}:0`;
  await newSession()(async () => {
    await turnStarted({}, ctxFor(wAsk, TURN));
    await dispatchTask(wAsk, TURN, OPEN, TASK);
  });
  const view = viewOf([
    ev("session.started", {}),
    ev("turn.started", { turnId: TURN, cause: { policy: "test" }, follows: null }, { turnId: TURN }),
    ev("model.requested", { runId: "r1", owner: { turnId: TURN } }, { turnId: TURN, runId: "r1" }),
    ev("call.requested", { callId: OPEN, owner: { runId: "r1" }, capability: { kind: "agent", name: "agent" } }, { turnId: TURN, runId: "r1" }),
    ev("task.started", { taskId: TASK, kind: "agent", name: "agent", startedBy: { callId: OPEN } }, { turnId: TURN }),
    ev("call.started", { callId: OPEN, taskId: TASK }, { turnId: TURN }),
    ev("turn.started", { turnId: LATER_TURN, cause: { policy: "test" }, follows: null }, { turnId: LATER_TURN }),
    ev("model.requested", { runId: "r2", owner: { turnId: LATER_TURN } }, { turnId: LATER_TURN, runId: "r2" }),
    ev("call.requested", { callId: CONT, owner: { runId: "r2" }, capability: { kind: "agent", name: "agent" } }, { turnId: LATER_TURN, runId: "r2" }),
    ev("call.started", { callId: CONT, taskId: TASK }, { turnId: LATER_TURN }),
  ]);
  const event = { type: "call.started", data: { callId: CONT, taskId: TASK }, scope: { turnId: LATER_TURN } };
  const ctx = (): unknown => Object.assign(ctxFor(wLater, LATER_TURN) as object, { view });
  await newSession()(async () => {
    await enterTurn(wLater, LATER_TURN);
    await requestedHook({ data: { actions: [{ kind: "subagent-call", callId: CONT, subagentName: "agent" }] } }, ctxFor(wLater, LATER_TURN));
    await continuedHook(event, ctx());
  });
  const claimAfterFirst = await store.getTaskResult(ORG, claimKey);
  ok(
    claimAfterFirst !== null && JSON.parse(claimAfterFirst).call === CONT && JSON.parse(claimAfterFirst).turn === LATER_TURN,
    `§6i/CONTROL: the clean first run marks this turn's claim dispatched with the call (got ${String(claimAfterFirst)})`,
  );
  let claimWrites = 0;
  liveStore.putTaskResult = function (this: unknown, ...a: unknown[]) {
    if (a[1] === claimKey) claimWrites++;
    return realPut.apply(this, a);
  };
  try {
    await newSession()(async () => {
      await enterTurn(wLater, LATER_TURN);
      await continuedHook(event, ctx());
    });
    ok(claimWrites === 0, `🔴 §6i: a re-run after a clean first run writes the claim row no second time (writes: ${claimWrites})`);
    await store.putTaskResult(ORG, claimKey, JSON.stringify({ turn: LATER_TURN }), new Date().toISOString(), 60 * 60 * 1000);
    claimWrites = 0;
    await newSession()(async () => {
      await enterTurn(wLater, LATER_TURN);
      await continuedHook(event, ctx());
    });
    const repaired = await store.getTaskResult(ORG, claimKey);
    ok(
      claimWrites === 1 && repaired !== null && JSON.parse(repaired).call === CONT,
      `🔴 §6i: a first run that died before the mark leaves the commit's claim, and the re-run marks it with the call (writes: ${claimWrites}, got ${String(repaired)})`,
    );
    const other = JSON.stringify({ turn: "turn_2819i_other" });
    await store.putTaskResult(ORG, claimKey, other, new Date().toISOString(), 60 * 60 * 1000);
    claimWrites = 0;
    await newSession()(async () => {
      await enterTurn(wLater, LATER_TURN);
      await continuedHook(event, ctx());
    });
    ok(
      claimWrites === 0 && (await store.getTaskResult(ORG, claimKey)) === other,
      `🔴 §6i: the re-run never marks ANOTHER turn's claim (writes: ${claimWrites})`,
    );
  } finally {
    liveStore.putTaskResult = realPut;
  }
}
liveStore.getTaskResult = realGet;
liveStore.putTaskResult = realPut;

console.log(`settlement-once: ${passed} assertions passed`);
