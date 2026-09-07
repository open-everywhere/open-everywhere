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

const dir = join(tmpdir(), `open-everywhere-turn-closeout-test-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
process.env.OE_ORG = "acme";

const { registerSlackTestBridge, registerSlackFixtureCodec, registerSlackFixtureMapper, registerSlackFixturePostArm } =
  await import("./_slack-test-stubs.js");
const { registerConfig } = await import("../agent/access/config.js");
const { defineDomain } = await import("../agent/memory/domain.js");
const { registerUnifiedWakeTarget, mintWakeId } = await import("../agent/channels/unified-window.js");
const { unifiedSupervisorToken } = await import("../agent/channels/unified-supervisor.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { registerSettings, resetSettingsForTest } = await import("../agent/settings/settings.js");
const { resolvePartition } = await import("../agent/memory/partition.js");
const { markThreadEngaged, isThreadStopped } = await import("../agent/channels/engagement.js");
const { resolvePrimaryModel } = await import("../agent/model/routing.js");
const { STEP_BOUNDARY_ACTION, STEP_BOUNDARY_MARKER } = await import("../agent/model/step-boundary.js");
const {
  CLOSEOUT_REFUSAL_LIMIT,
  _resetTurnCloseoutForTest,
  noteTurnCloseoutRefusal,
  turnCloseoutFor,
  turnCloseoutTripped,
} = await import("../agent/model/turn-closeout.js");
const { REPLY_STOPPED_REFUSAL_REASON, WAKE_DECLINED_REFUSAL_REASON } = await import("../agent/channels/reply-signal.js");
const { NO_REPLY_REDUNDANT_CLOSEOUT_REASON } = await import("../agent/tools/no_reply.js");
const { STAND_DOWN_ACTION } = await import("../agent/tools/stand_down.js");
const { notePendingDelegation } = await import("../agent/access/pending-delegation-signal.js");

type BindableContext = import("../agent/identity/binding.js").BindableContext;
type ModelBackend = import("../agent/model/routing.js").ModelBackend;
type RoutedCallOptions = import("../agent/model/routing.js").RoutedCallOptions;

const ORG = "acme";
const DOMAIN = "payments";
const CHAN = "C1";
const SURFACE = `slack/T1/${CHAN}`;
const TOKEN = unifiedSupervisorToken(DOMAIN, 1);
const THREAD = "1757400560.000100";

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
const noReplyTool = (await import("../agent/tools/no_reply.js")).default as unknown as {
  readonly execute: (input: { reason: string; explanation?: string }, ctx: unknown) => Promise<{ acknowledged: boolean; note: string }>;
};
const standDownTool = (await import("../agent/tools/stand_down.js")).default as unknown as {
  readonly execute: (input: { reason?: string }, ctx: unknown) => Promise<{ standingDown: boolean; note: string }>;
};
interface Armed {
  readonly execute: (input: Record<string, unknown>, ctx: unknown) => Promise<unknown>;
}
type Handler = (event: unknown, ctx: unknown) => unknown;
const arm = (ctx: unknown): Armed | null => (replyTool as unknown as { events: Record<string, Handler> }).events["session.started"]({}, ctx) as Armed | null;

function ctxFor(turnWake: string, turnId: string, sessionId = "turn-closeout-test", threadTs = THREAD): BindableContext {
  return {
    channel: { kind: "channel:unified", continuationToken: `unified:${TOKEN}` },
    session: {
      id: sessionId,
      turn: { id: turnId },
      auth: {
        current: {
          attributes: {
            oe_platform: "slack",
            oe_wake_id: turnWake,
            oe_window_token: TOKEN,
            channel_id: CHAN,
            team_id: "T1",
            channel_type: "channel",
            is_private: "false",
            thread_ts: threadTs,
          },
          principalId: "U1",
          principalType: "slack-user",
        },
      },
    },
  } as unknown as BindableContext;
}

interface FakeCall {
  id: string;
  options: RoutedCallOptions;
}

function fakeBackend(calls: FakeCall[]): ModelBackend {
  return {
    model: (id) => ({
      specificationVersion: "v4",
      provider: "fake",
      modelId: id,
      supportedUrls: {},
      doGenerate: async (options: RoutedCallOptions) => {
        calls.push({ id, options });
        return { ok: true };
      },
      doStream: async (options: RoutedCallOptions) => {
        calls.push({ id, options });
        return { ok: true };
      },
    }),
    applyOptions: (_route, options) => options,
  };
}
const DEFAULTS = { primary: { id: "vendor/default-model" }, utility: { id: "vendor/utility-model" } };

async function oneRoundTrip(ctx: BindableContext): Promise<{ text: string | undefined; backendCalls: number }> {
  const calls: FakeCall[] = [];
  const model = await resolvePrimaryModel(ctx, DEFAULTS, { domains: () => [], backend: fakeBackend(calls) });
  const out = (await model.doGenerate({ prompt: [] } as unknown as RoutedCallOptions)) as { content?: { type: string; text?: string }[] };
  const text = out.content?.find((c) => c.type === "text")?.text;
  return { text, backendCalls: calls.length };
}

const nodeRequire = createRequire(import.meta.url);
const eveRoot = dirname(nodeRequire.resolve("eve/package.json"));
const abs = (rel: string): string => pathToFileURL(join(eveRoot, rel)).href;
const { ContextContainer, contextStorage } = await import(abs("dist/src/context/container.js"));
const { SessionKey } = await import(abs("dist/src/context/keys.js"));
function newSession(id = "turn-closeout-test"): <T>(fn: () => Promise<T>) => Promise<T> {
  const c = new ContextContainer();
  c.set(SessionKey, { sessionId: id, auth: null, turn: 1, parent: undefined });
  return <T>(fn: () => Promise<T>): Promise<T> => contextStorage.run(c, fn);
}

async function callNoReply(turnWake: string, turnId: string): Promise<{ note?: string; error?: string }> {
  return noReplyTool
    .execute({ reason: "not_relevant" }, ctxFor(turnWake, turnId))
    .then((r) => ({ note: r.note }))
    .catch((e: unknown) => ({ error: String(e) }));
}

async function callReply(
  turnWake: string,
  turnId: string,
  wake: string,
  text: string,
  done = true,
  sessionId = "turn-closeout-test",
): Promise<{ posted?: boolean; error?: string }> {
  const ctx = ctxFor(turnWake, turnId, sessionId);
  const armed = arm(ctx);
  if (!armed) return { error: "reply did not arm" };
  return armed
    .execute({ text, wake, done }, ctx)
    .then((r) => r as { posted?: boolean })
    .catch((e: unknown) => ({ error: String(e) }));
}

async function wake(channelId: string, threadTs = THREAD, at = new Date().toISOString()): Promise<string> {
  const id = mintWakeId();
  await registerUnifiedWakeTarget(store, ORG, id, { platform: "slack", channelId, threadTs }, at, TOKEN);
  return id;
}

const refusedReasons = async (wakeId: string): Promise<string[]> =>
  (await readAudit({ org: ORG, action: "reply.refused" }))
    .map((r) => (r.detail ?? {}) as Record<string, unknown>)
    .filter((d) => d["wakeId"] === wakeId)
    .map((d) => String(d["reason"]));

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 60));

registerSettings({ turn: { stepBudget: 1000, stepBackstopMultiple: 3 } });

{
  _resetTurnCloseoutForTest();
  const inTurn = newSession();
  const w = await wake("C_CLOSED");
  const ctx = ctxFor(w, "turn_100");

  const before = await inTurn(() => oneRoundTrip(ctx));
  ok(before.backendCalls === 1, "§1/CONTROL: before anything closes the wake, a round-trip reaches the REAL backend");
  ok(before.text === undefined, "§1/CONTROL: …and answers no harness text — this is an ordinary routed model");
  ok(turnCloseoutTripped("turn-closeout-test", "turn_100") === false, "§1/CONTROL: no latch is armed on an ordinary turn");

  await inTurn(() => callNoReply(w, "turn_100"));
  const overReply = await inTurn(() => callReply(w, "turn_100", w, "Noted — the sync is moving to 3:30."));
  ok(typeof overReply.error === "string", "§1: the reply on the DECLINED wake is still REFUSED (OPE-748's teeth are untouched)");

  const latch = turnCloseoutFor("turn-closeout-test", "turn_100");
  ok(latch?.count === CLOSEOUT_REFUSAL_LIMIT, "§1/WIRING: the refusal ARMED the closeout latch — reachable from the shipped tool, not only from its helper");
  ok(latch?.reason === WAKE_DECLINED_REFUSAL_REASON, "§1: …under the refusal's OWN reason, so the turn ending names why");

  const after = await inTurn(() => oneRoundTrip(ctx));
  ok(after.backendCalls === 0, "§1: the VERY NEXT round-trip makes NO backend call — the spin stops costing immediately");
  ok((after.text ?? "").includes(STEP_BOUNDARY_MARKER), "§1: …and answers harness text, so eve's own continue-decision ends the turn (no tool call in the message)");
  ok((after.text ?? "").includes(WAKE_DECLINED_REFUSAL_REASON), "§1: …naming the refusal that ended it");
  ok(!/try again|retry|re-?send/i.test(after.text ?? ""), "§1: …and NOT inviting a retry — the turn is over, the next message wakes the seat again");
}

{
  _resetTurnCloseoutForTest();
  registerSettings({ turn: { stepBudget: 0, stepBackstopMultiple: 3 } });
  const inTurn = newSession();
  const w = await wake("C_NOBUDGET");
  const ctx = ctxFor(w, "turn_150");

  const before = await inTurn(() => oneRoundTrip(ctx));
  ok(before.backendCalls === 1, "§2/CONTROL: with the step budget at 0 an ordinary round-trip still reaches the backend");

  await inTurn(() => callNoReply(w, "turn_150"));
  await inTurn(() => callReply(w, "turn_150", w, "Answering the wake I just declined."));
  const after = await inTurn(() => oneRoundTrip(ctx));
  ok(after.backendCalls === 0, "§2: the closeout ends the turn even with the STEP BOUNDARY SWITCHED OFF — it is a different guard, not the old budget renamed");
  registerSettings({ turn: { stepBudget: 1000, stepBackstopMultiple: 3 } });
}

{
  _resetTurnCloseoutForTest();
  const inTurn = newSession();
  const w = await wake("C_OPEN");
  const ctx = ctxFor(w, "turn_200");
  const before = posted.length;

  const answer = await inTurn(() => callReply(w, "turn_200", w, "17 plus 25 is 42."));
  ok(answer.posted === true, "§3: a reply on an OPEN wake posts");
  ok(posted.length === before + 1, "§3/ROOM: and it reached the room");
  ok(turnCloseoutTripped("turn-closeout-test", "turn_200") === false, "§3: a delivered reply arms NOTHING");
  const next = await inTurn(() => oneRoundTrip(ctx));
  ok(next.backendCalls === 1, "§3: …so the next round-trip is the ordinary routed model and the turn keeps going");
}

{
  _resetTurnCloseoutForTest();
  const inTurn = newSession();
  const w = await wake("C_STOP");
  const ctx = ctxFor(w, "turn_300");
  const partition = resolvePartition(ctx);
  await markThreadEngaged(partition, THREAD, new Date().toISOString(), { participating: true });
  ok((await isThreadStopped(partition, THREAD)) === false, "§4/CONTROL: an engaged thread is NOT stopped before the verb runs");

  const before = posted.length;
  const stop = await inTurn(() => standDownTool.execute({ reason: "asked me to stop" }, ctx).catch((e: unknown) => ({ error: String(e) })));
  ok((stop as { standingDown?: boolean }).standingDown === true, "§4/WIRING: the real `stand_down` marked the thread");
  ok((await isThreadStopped(partition, THREAD)) === true, "§4/WIRING: …and the reply path's own reader sees the stored flag");

  const ack = await inTurn(() => callReply(w, "turn_300", w, "Standing down here — I'll stay quiet unless someone @mentions me again.", false));
  ok(ack.posted === true, "§4: the ONE acknowledgement `stand_down` asks for still POSTS");
  ok(posted.length === before + 1, "§4/ROOM: …and it reached the room");
  ok(turnCloseoutTripped("turn-closeout-test", "turn_300") === false, "§4: the allowed acknowledgement does NOT end the turn");

  const again = await inTurn(() => callReply(w, "turn_300", w, "Here is that same answer once more.", false));
  ok(typeof again.error === "string", "§4: the NEXT post in the same turn is REFUSED");
  ok(again.posted !== true, "§4: …and reports no post");
  ok(/stand down/i.test(again.error!), "§4: refused with the stand-down steer, not some incidental error");
  ok(posted.length === before + 1, "§4/ROOM: NOTHING further reached the room. This is the assertion the six live re-posts exist for");

  await settle();
  ok((await refusedReasons(w)).includes(REPLY_STOPPED_REFUSAL_REASON), "§4/AUDIT: the refusal is a ROW under reason `stopped`, countable apart from every other refusal shape");
  const latch = turnCloseoutFor("turn-closeout-test", "turn_300");
  ok(latch?.reason === REPLY_STOPPED_REFUSAL_REASON, "§4: …and it armed the closeout under that same reason");
  const after = await inTurn(() => oneRoundTrip(ctx));
  ok(after.backendCalls === 0, "§4: so the turn ENDS rather than posting a third, fourth and fifth time");
  ok((after.text ?? "").includes(REPLY_STOPPED_REFUSAL_REASON), "§4: …and the ending names the stop as its reason");

  const standDownRows = await readAudit({ org: ORG, action: STAND_DOWN_ACTION });
  ok(standDownRows.length === 1, "§4/AUDIT: the stand-down itself is still recorded exactly once — this change adds a guard, it does not re-run the verb");
}

{
  _resetTurnCloseoutForTest();
  const inTurn = newSession();
  const openThread = "1757400560.000900";
  const w = await wake("C_NOSTOP", openThread);
  const ctx = ctxFor(w, "turn_400", "turn-closeout-test", openThread);
  const partition = resolvePartition(ctx);
  await markThreadEngaged(partition, openThread, new Date().toISOString(), { participating: true });
  ok((await isThreadStopped(partition, openThread)) === false, "§5/CONTROL: this thread carries NO stored stop");

  const before = posted.length;
  const armed = arm(ctx)!;
  const first = await inTurn(() => armed.execute({ text: "Part one of the answer.", wake: w, done: false }, ctx).catch((e: unknown) => ({ error: String(e) })));
  const second = await inTurn(() => armed.execute({ text: "Part two of the answer.", wake: w, done: false }, ctx).catch((e: unknown) => ({ error: String(e) })));
  ok((first as { posted?: boolean }).posted === true, "§5: the first post delivers");
  ok((second as { posted?: boolean }).posted === true, "§5: and so does the SECOND — a same-turn duplicate stays DISCOURAGED, never hard-blocked (OPE-1452)");
  ok(posted.length === before + 2, "§5/ROOM: both messages reached the room");
  ok(turnCloseoutTripped("turn-closeout-test", "turn_400") === false, "§5: and neither armed the closeout — this change ends a turn the host already refused, it refuses nothing new");
}

{
  _resetTurnCloseoutForTest();
  const inTurn = newSession();
  const w = await wake("C_TWICE");
  const ctx = ctxFor(w, "turn_500");

  const one = await inTurn(() => callNoReply(w, "turn_500"));
  ok(one.error === undefined, "§6: the first `no_reply` executes cleanly");
  ok(turnCloseoutTripped("turn-closeout-test", "turn_500") === false, "§6/CONTROL: one silence call arms nothing — a turn is allowed to end this way");

  const two = await inTurn(() => callNoReply(w, "turn_500"));
  ok(two.error === undefined, "§6: the redundant second call still returns cleanly — it is not turned into an error");
  ok(turnCloseoutFor("turn-closeout-test", "turn_500")?.reason === NO_REPLY_REDUNDANT_CLOSEOUT_REASON, "§6: …but it ARMS the closeout under its own reason");
  const after = await inTurn(() => oneRoundTrip(ctx));
  ok(after.backendCalls === 0, "§6: so the turn ends on the next round-trip");
}

{
  _resetTurnCloseoutForTest();
  const inTurn = newSession();
  const w = await wake("C_AUDIT");
  const ctx = ctxFor(w, "turn_600");

  await inTurn(() => callNoReply(w, "turn_600"));
  await inTurn(() => callReply(w, "turn_600", w, "Answering a wake I declined."));
  for (let i = 0; i < 4; i++) await inTurn(() => oneRoundTrip(ctx));
  await settle();

  const rows = (await readAudit({ org: ORG, action: STEP_BOUNDARY_ACTION })).filter((r) => (r.detail ?? {})["turnId"] === "turn_600");
  ok(rows.length === 1, "§7/AUDIT: exactly ONE `turn.step_boundary` row for the turn, however many round-trips the stub then serves");
  ok(rows[0]?.detail?.["tier"] === "closed", "§7/AUDIT: under the `closed` tier, countable apart from the soft and hard step boundaries");
  ok(rows[0]?.detail?.["reason"] === WAKE_DECLINED_REFUSAL_REASON, "§7/AUDIT: NAMING the refusal that ended the turn — the OPE-1520 ask");
  ok(rows[0]?.detail?.["sessionId"] === "turn-closeout-test", "§7/AUDIT: keyed to the session, so a spiral is attributable");
}

{
  _resetTurnCloseoutForTest();
  const mine = newSession("sess-A");
  const theirs = newSession("sess-B");
  const w = await wake("C_KEYED");

  await mine(() => callNoReply(w, "turn_0"));
  await mine(() => callReply(w, "turn_0", w, "Mine.", true, "sess-A"));
  ok(turnCloseoutTripped("sess-A", "turn_0") === true, "§8: my turn_0 is latched");
  ok(turnCloseoutTripped("sess-B", "turn_0") === false, "§8: a DIFFERENT session's turn_0 is NOT — eve mints `turn_0` for every session's first turn, so a turn-id-only latch would end a stranger's turn");
  ok(turnCloseoutTripped("sess-A", "turn_1") === false, "§8: and the same session's NEXT turn is not either");

  const theirRoundTrip = await theirs(() => oneRoundTrip(ctxFor(w, "turn_0", "sess-B")));
  ok(theirRoundTrip.backendCalls === 1, "§8: so the stranger's turn keeps running against the real backend");
}

{
  _resetTurnCloseoutForTest();
  const w = await wake("C_FAILOPEN");
  const ctx = ctxFor(w, "turn_700");
  const partition = resolvePartition(ctx);
  ok((await isThreadStopped(partition, THREAD)) === true, "§9/CONTROL: §4's stored stop is still on this thread, so the guard has something to read");

  const before = posted.length;
  const a = await callReply(w, "turn_700", w, "Posted because the valve could not be spent.", false);
  const b = await callReply(w, "turn_700", w, "And so is this one.", false);
  ok(a.posted === true && b.posted === true, "§9: with no eve context BOTH posts land — a guard that cannot record its own state must never swallow an answer");
  ok(posted.length === before + 2, "§9/ROOM: both messages reached the room");
  ok(noteTurnCloseoutRefusal({} as BindableContext, "anything") === 0, "§9: and the latch writer answers 0 rather than throwing on a context it cannot read");
}

{
  _resetTurnCloseoutForTest();
  const inTurn = newSession();
  const ackThread = "1757400560.001000";
  const w = await wake("C_ACKGATE", ackThread);
  const ctx = ctxFor(w, "turn_800", "turn-closeout-test", ackThread);
  const partition = resolvePartition(ctx);
  await markThreadEngaged(partition, ackThread, new Date().toISOString(), { participating: true });
  await inTurn(async () => {
    notePendingDelegation("turn_800", "task_ope1520", w);
    await standDownTool.execute({ reason: "asked me to stop" }, ctx);
  });
  ok((await isThreadStopped(partition, ackThread)) === true, "§10/CONTROL: the thread is stopped before the acknowledgement is attempted");

  const before = posted.length;
  const refusedDownstream = await inTurn(() => callReply(w, "turn_800", w, "Standing down here.", true));
  ok(typeof refusedDownstream.error === "string", "§10/CONTROL: a gate BELOW the stand-down read refuses the acknowledgement call");
  ok(!/stand down/i.test(refusedDownstream.error!), "§10/CONTROL: …and it is that other gate, not the stand-down, that refused");
  ok(posted.length === before, "§10/CONTROL: nothing was posted");

  const resent = await inTurn(() => callReply(w, "turn_800", w, "Standing down here.", false));
  ok(resent.posted === true, "§10: the RE-SEND still POSTS — a refused call must not spend the one acknowledgement a stand-down allows");
  ok(posted.length === before + 1, "§10/ROOM: the acknowledgement the human is owed reached the room");
  ok(turnCloseoutTripped("turn-closeout-test", "turn_800") === false, "§10: and nothing ended the turn before the acknowledgement landed");

  const third = await inTurn(() => callReply(w, "turn_800", w, "And again.", false));
  ok(typeof third.error === "string", "§10: only THEN is the next post refused");
  ok(/stand down/i.test(third.error!), "§10: …and now it is the stand-down that refuses");
  ok(posted.length === before + 1, "§10/ROOM: nothing further reached the room");
}

resetSettingsForTest();
rmSync(dir, { recursive: true, force: true });
console.log(`✓ turn closeout boundary: ${passed} assertions passed (turn ends within one round-trip, budget-independent, open wake untouched, stand-down silences the rest of the turn, duplicate valve intact, redundant no_reply, one audit row naming the reason, session keying, fail-open)`);
