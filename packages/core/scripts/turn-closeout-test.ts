import { tmpdir } from "node:os";
import { readFileSync, readdirSync, rmSync } from "node:fs";
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

const dir = join(tmpdir(), `open-everywhere-turn-closeout-test-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
_setDeploymentIdentityForTest({ org: "acme" });

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
const { STEP_BOUNDARY_ACTION, STEP_BOUNDARY_MARKER, _resetStepBoundaryCountsForTest } = await import("../agent/model/step-boundary.js");
const { deleteTurnState, readTurnState, writeTurnState, turnPairKey, turnStateRowKey, TURN_STATE_STORE_DEADLINE_MS } = await import(
  "../agent/model/turn-state.js"
);
const {
  CLOSEOUT_REFUSAL_LIMIT,
  _resetTurnCloseoutForTest,
  noteTurnCloseoutRefusal,
  turnCloseoutFor,
  turnCloseoutTripped,
} = await import("../agent/model/turn-closeout.js");
const {
  REPLY_STOPPED_REFUSAL_REASON,
  WAKE_DECLINED_REFUSAL_REASON,
  wasStoppedAckSpentThisTurn,
  FORCED_OVERRIDE_TURN_LIMIT,
  REPLY_FORCED_LOOP_REASON,
} = await import("../agent/channels/reply-signal.js");
const { NO_REPLY_REDUNDANT_CLOSEOUT_REASON } = await import("../agent/tools/no_reply.js");
const { STAND_DOWN_ACTION } = await import("../agent/tools/stand_down.js");
const { notePendingDelegation } = await import("../agent/access/pending-delegation-signal.js");
const { seedTailWindow, tailWindowFor } = await import("../agent/channels/session-tail-record.js");

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
  loadDomains: () => [defineDomain({ name: DOMAIN, reach: [SURFACE], ambientSupervisor: true, mode: "unified" })],
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

interface ControlledDeadlines {
  waitForNext(): Promise<void>;
  fireNext(): Promise<void>;
}

async function withControlledStoreDeadlines<T>(run: (deadlines: ControlledDeadlines) => Promise<T>): Promise<T> {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  interface Timer {
    active: boolean;
    run(): void;
  }
  const controlled = new Set<Timer>();
  const queue: Timer[] = [];

  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    if (delay !== TURN_STATE_STORE_DEADLINE_MS) {
      return realSetTimeout(callback as (...args: never[]) => void, delay, ...(args as never[]));
    }
    const timer: Timer = {
      active: true,
      run: () => {
        if (!timer.active) return;
        timer.active = false;
        callback(...args);
      },
    };
    controlled.add(timer);
    queue.push(timer);
    return timer as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
    const timer = handle as unknown as Timer;
    if (controlled.has(timer)) {
      timer.active = false;
      return;
    }
    realClearTimeout(handle);
  }) as typeof clearTimeout;

  const next = async (): Promise<Timer> => {
    for (let i = 0; i < 100; i++) {
      const timer = queue.find((candidate) => candidate.active);
      if (timer) return timer;
      await Promise.resolve();
    }
    throw new Error("fixture observed no armed turn-state store deadline");
  };

  try {
    return await run({
      waitForNext: async () => void (await next()),
      fireNext: async () => {
        (await next()).run();
        await Promise.resolve();
      },
    });
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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
  threadTs = THREAD,
): Promise<{ posted?: boolean; error?: string }> {
  const ctx = ctxFor(turnWake, turnId, sessionId, threadTs);
  const armed = arm(ctx);
  if (!armed) return { error: "reply did not arm" };
  return armed
    .execute({ text, wake, done }, ctx)
    .then((r) => r as { posted?: boolean })
    .catch((e: unknown) => ({ error: String(e) }));
}

function sessionlessCtx(ctx: BindableContext): BindableContext {
  const raw = ctx as unknown as Record<string, unknown>;
  const session = raw["session"] as Record<string, unknown>;
  return { ...raw, session: { ...session, id: undefined } } as unknown as BindableContext;
}

async function callReplySessionless(turnWake: string, turnId: string, wake: string, text: string, done = true): Promise<{ posted?: boolean; error?: string }> {
  const ctx = sessionlessCtx(ctxFor(turnWake, turnId));
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

const AUTHORED_COPY_EXTENSIONS = [".ts", ".js", ".md"] as const;

function authoredSourcesUnder(dir: URL): { readonly url: URL; readonly src: string }[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((e) => {
    if (e.name === "dist" || e.name === "node_modules") return [];
    const child = new URL(`${e.name}${e.isDirectory() ? "/" : ""}`, dir);
    if (e.isDirectory()) return authoredSourcesUnder(child);
    if (!AUTHORED_COPY_EXTENSIONS.some((ext) => e.name.endsWith(ext))) return [];
    return [{ url: child, src: readFileSync(child, "utf8") }];
  });
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
  ok(/already posted here once this turn/i.test(again.error!), "§4/COPY: the refusal says the turn has already POSTED once — true whether or not that post acknowledged the stop");
  ok(!/acknowledgement has already gone out/i.test(again.error!), "§4/COPY: …and never claims an acknowledgement went out, which is false in a turn that only posted an ordinary message into a stopped conversation");
  const copySources = authoredSourcesUnder(new URL("../../", import.meta.url));
  ok(copySources.length > 500, "§4/COPY: the source walk really read the tree — a walk that found nothing would pass the next assertion for free");
  const falseAckCopy = /acknowledgement\s+has\s+already\s+gone\s+out/i;
  const selfPath = new URL(import.meta.url).pathname;
  const reintroduced = copySources.filter((f) => f.url.pathname !== selfPath && falseAckCopy.test(f.src));
  ok(reintroduced.length === 0, `§4/COPY: no authored source under packages/ carries the false acknowledgement sentence — found in ${reintroduced.map((f) => f.url.pathname).join(", ")}`);
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
  ok(turnCloseoutTripped("turn-closeout-test", "turn_400") === false, "§5: and neither armed the closeout — an unforced duplicate is a matter of style, and this latch refuses nothing new");
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
  const a = await callReply(w, "turn_700", w, "The one allowed post.", false);
  ok(a.posted === true, "§9: the ONE allowed post still lands with no eve context at all");
  const b = await callReply(w, "turn_700", w, "And this one is refused.", false);
  ok(b.posted !== true, "§9: 🔴 …and the SECOND is refused — the durable half needs no eve context, so this turn CAN record its valve and the stop is honoured (OPE-1551)");
  ok(posted.length === before + 1, "§9/ROOM: exactly one message reached the stopped conversation");

  const sessionlessBefore = posted.length;
  const c = await callReplySessionless(w, "turn_701", w, "Nothing here can record a valve.", false);
  const d = await callReplySessionless(w, "turn_701", w, "So this one lands too.", false);
  ok(c.posted === true && d.posted === true, "§9: with NEITHER half able to record, BOTH posts land — a guard that cannot record its own state must never swallow an answer");
  ok(posted.length === sessionlessBefore + 2, "§9/ROOM: both messages reached the room");
  ok((await noteTurnCloseoutRefusal({} as BindableContext, "anything")) === 0, "§9: and the latch writer answers 0 rather than throwing on a context it cannot read");
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

{
  _resetTurnCloseoutForTest();
  _resetStepBoundaryCountsForTest();
  const inTurn = newSession();
  const w = await wake("C_RESUME");
  const ctx = ctxFor(w, "turn_900");

  await inTurn(() => callNoReply(w, "turn_900"));
  await inTurn(() => callReply(w, "turn_900", w, "Answering a wake I declined."));
  ok(turnCloseoutTripped("turn-closeout-test", "turn_900") === true, "§11/CONTROL: instance A really did arm the latch");

  _resetTurnCloseoutForTest();
  _resetStepBoundaryCountsForTest();
  ok(turnCloseoutTripped("turn-closeout-test", "turn_900") === false, "§11/CONTROL: the fresh instance's cache holds no latch — the state that used to lose the arming outright");

  const onB = await inTurn(() => oneRoundTrip(ctx));
  ok(onB.backendCalls === 0, "§11a: the fresh instance's FIRST round-trip resolves the turn-ending stub — the arming refusal wrote the turn's durable row, so no round-trip on instance A was needed to save it");
  ok(onB.text?.startsWith(STEP_BOUNDARY_MARKER) === true, "§11a: …and the stub says the harness ended the turn");
  ok(onB.text?.includes(WAKE_DECLINED_REFUSAL_REASON) === true, "§11a: naming the refusal instance A drew, so the REASON survives the instance change too");

  await settle();
  const afterB = (await readAudit({ org: ORG, action: STEP_BOUNDARY_ACTION })).filter((r) => (r.detail ?? {})["turnId"] === "turn_900");
  ok(afterB.length === 1, "§11a/AUDIT: one row, written by the instance that actually served the ending");

  _resetTurnCloseoutForTest();
  _resetStepBoundaryCountsForTest();
  const onC = await inTurn(() => oneRoundTrip(ctx));
  ok(onC.backendCalls === 0, "§11b: a third instance still serves the stub");
  await settle();
  const afterC = (await readAudit({ org: ORG, action: STEP_BOUNDARY_ACTION })).filter((r) => (r.detail ?? {})["turnId"] === "turn_900");
  ok(afterC.length === 1, "§11b/AUDIT: still exactly ONE row for the turn across all three instances — `reported` rides the row, so a cold instance does not re-record a boundary a warm one already wrote");

  _resetTurnCloseoutForTest();
  _resetStepBoundaryCountsForTest();
  await deleteTurnState(turnPairKey("turn-closeout-test", "turn_900"));
  const forgotten = await inTurn(() => oneRoundTrip(ctx));
  ok(forgotten.backendCalls === 1, "§11c/CONTROL: with the durable row gone too, the turn keeps running against the real backend — so every assertion above is carried by the row and by nothing else in the fixture");
}

{
  _resetTurnCloseoutForTest();
  _resetStepBoundaryCountsForTest();
  const inTurn = newSession();
  const THREAD_12 = "1757400560.001200";
  const wOld = await wake("C_SIB", THREAD_12);
  const wTurn = await wake("C_SIB", THREAD_12);
  const OTHER_THREAD = "1757400560.001290";
  const wOther = await wake("C_SIB_OTHER", OTHER_THREAD);

  const ctx = ctxFor(wTurn, "turn_1200", "turn-closeout-test", THREAD_12);
  const partition = resolvePartition(ctx);
  await markThreadEngaged(partition, THREAD_12, new Date().toISOString(), { participating: true });
  const stop = await inTurn(() => standDownTool.execute({ reason: "asked me to stop" }, ctx).catch((e: unknown) => ({ error: String(e) })));
  ok((stop as { standingDown?: boolean }).standingDown === true, "§12/WIRING: the real `stand_down` marked the bound thread");
  ok((await isThreadStopped(partition, THREAD_12)) === true, "§12/WIRING: …and it is THREAD_12 that carries the stop — every reply below binds to that thread, so the stop this leg stages is the stop the gate reads");
  ok((await isThreadStopped(partition, OTHER_THREAD)) === false, "§12/WIRING: …while the control's own conversation is NOT stopped, which is what makes its post a real negative control rather than an unstopped accident");

  const before = posted.length;
  const first = await inTurn(() => callReply(wTurn, "turn_1200", wOld, "Standing down — I'll stay quiet here.", false, "turn-closeout-test", THREAD_12));
  ok(first.posted === true, "§12: the ONE acknowledgement still posts, even under a sibling wake id");
  ok(posted.length === before + 1, "§12/ROOM: …and it reached the room");

  const again = await inTurn(() => callReply(wTurn, "turn_1200", wOld, "Here is that same answer once more.", false, "turn-closeout-test", THREAD_12));
  ok(typeof again.error === "string", "§12: 🔴 a SECOND post under a DIFFERENT wake naming the SAME conversation is REFUSED");
  ok(again.posted !== true, "§12: …and reports no post");
  ok(/stand down/i.test(again.error!), "§12: refused with the stand-down steer, not some incidental error");
  ok(posted.length === before + 1, "§12/ROOM: nothing further reached the stopped conversation");
  await settle();
  ok((await refusedReasons(wOld)).includes(REPLY_STOPPED_REFUSAL_REASON), "§12/AUDIT: the refusal carries reason `stopped`, on the sibling wake's own row");

  _resetTurnCloseoutForTest();
  const inTurn2 = newSession("turn-closeout-test-12b");
  const ctx2 = ctxFor(wTurn, "turn_1201", "turn-closeout-test-12b", THREAD_12);
  const otherBefore = posted.length;
  const elsewhere = await inTurn2(() => callReply(wTurn, "turn_1201", wOther, "Answering a different room.", false, "turn-closeout-test-12b", THREAD_12));
  ok(elsewhere.posted === true, "§12/CONTROL: a sibling wake naming a DIFFERENT conversation still posts — the stop is about one conversation, not about the turn");
  ok(posted.length === otherBefore + 1, "§12/CONTROL: …and that post reached its own room");

  const elsewhereAgain = await inTurn2(() => callReply(wTurn, "turn_1201", wOther, "And one more for that same different room.", false, "turn-closeout-test-12b", THREAD_12));
  ok(elsewhereAgain.posted === true, "§12/CONTROL: 🔴 a SECOND post to the UN-stopped conversation lands too — the stop in THREAD_12 never spent this turn's valve, which it would have had the gate read the wake id alone");
  ok(elsewhereAgain.error === undefined, "§12/CONTROL: …and it was not refused for any other reason either");
  ok(posted.length === otherBefore + 2, "§12/CONTROL: …and both posts really reached that room");
  void ctx2;
}

{
  _resetTurnCloseoutForTest();
  _resetStepBoundaryCountsForTest();
  const THREAD_13 = "1757400560.001300";
  const w13 = await wake("C_RESUME_STOP", THREAD_13);
  const ctx13 = ctxFor(w13, "turn_1300", "turn-closeout-test", THREAD_13);
  const partition = resolvePartition(ctx13);
  await markThreadEngaged(partition, THREAD_13, new Date().toISOString(), { participating: true });

  const instanceA = newSession();
  const stop = await instanceA(() => standDownTool.execute({ reason: "asked me to stop" }, ctx13).catch((e: unknown) => ({ error: String(e) })));
  ok((stop as { standingDown?: boolean }).standingDown === true, "§13/WIRING: the thread is stopped");
  ok((await isThreadStopped(partition, THREAD_13)) === true, "§13/WIRING: …and it is THREAD_13, the thread every reply below binds to");

  const before = posted.length;
  const ack = await instanceA(() => callReply(w13, "turn_1300", w13, "Standing down here.", false, "turn-closeout-test", THREAD_13));
  ok(ack.posted === true, "§13/CONTROL: instance A spends the turn's ONE post");
  ok(posted.length === before + 1, "§13/CONTROL: …and it really reached the room");

  const instanceB = newSession();
  ok(
    (await instanceB(async () => wasStoppedAckSpentThisTurn("turn_1300"))) === false,
    "§13/CONTROL: the fresh instance's turn slot holds NO valve — the state that used to re-grant the post",
  );

  const resumed = await instanceB(() => callReply(w13, "turn_1300", w13, "Here is that same answer once more.", false, "turn-closeout-test", THREAD_13));
  ok(typeof resumed.error === "string", "§13: 🔴 the resumed instance's post is REFUSED — the valve rode the durable row across the instance change");
  ok(resumed.posted !== true, "§13: …and reports no post");
  ok(/stand down/i.test(resumed.error!), "§13: refused with the stand-down steer");
  ok(posted.length === before + 1, "§13/ROOM: the stopped conversation received exactly ONE message across both instances");

  const instanceC = newSession();
  await deleteTurnState(turnPairKey("turn-closeout-test", "turn_1300"));
  const forgotten = await instanceC(() => callReply(w13, "turn_1300", w13, "And again, with no record at all.", false, "turn-closeout-test", THREAD_13));
  ok(forgotten.posted === true, "§13/CONTROL: with the durable row deleted too, the post lands — the row is what refused it above");
  ok(posted.length === before + 2, "§13/CONTROL: …and that one really reached the room");
}

{
  _resetTurnCloseoutForTest();
  _resetStepBoundaryCountsForTest();
  const inTurn = newSession();
  const ctxNoSession = sessionlessCtx(ctxFor(await wake("C_NOSESSION"), "turn_1"));

  await inTurn(() => noteTurnCloseoutRefusal(ctxNoSession, "declined-this-turn"));
  ok(turnCloseoutTripped(undefined, "turn_1") === true, "§14/CONTROL: the sessionless turn's latch IS armed — in the CACHE, which still bounds it exactly as it did before the row existed");

  const shared = await store.getTaskResult(ORG, turnStateRowKey(turnPairKey(undefined, "turn_1")));
  ok(shared === null, "§14: 🔴 a sessionless turn writes NO durable row — the bare `turn_1` key is shared by every session's first turn");

  _resetTurnCloseoutForTest();
  const ctxKeyed = ctxFor(await wake("C_SESSIONED"), "turn_1", "session-14");
  await inTurn(() => noteTurnCloseoutRefusal(ctxKeyed, "declined-this-turn"));
  const keyed = await store.getTaskResult(ORG, turnStateRowKey(turnPairKey("session-14", "turn_1")));
  ok(keyed !== null, "§14/CONTROL: a SESSION-keyed turn does write its row at its own key");

  _resetTurnCloseoutForTest();
  ok(turnCloseoutTripped(undefined, "turn_1") === false, "§14: a fresh instance's sessionless `turn_1` reads NO latch — session-14's arming cannot end it");
  const reread = await inTurn(() => noteTurnCloseoutRefusal(ctxNoSession, "stopped"));
  ok(reread === 1, "§14: …so its own first refusal counts as the FIRST, not as a second on top of a stranger's row");
}

{
  _resetTurnCloseoutForTest();
  _resetStepBoundaryCountsForTest();
  const inTurn = newSession();
  const w15 = await wake("C_HUNG");
  const ctx15 = ctxFor(w15, "turn_1500");

  const realGet = store.getTaskResult.bind(store);
  const realPut = store.putTaskResult.bind(store);
  let hungReads = 0;
  const hang = <T>(): Promise<T> => {
    hungReads += 1;
    return new Promise<T>(() => {});
  };
  (store as unknown as Record<string, unknown>)["getTaskResult"] = hang;
  (store as unknown as Record<string, unknown>)["putTaskResult"] = hang;
  try {
    await withControlledStoreDeadlines(async (deadlines) => {
      let completed = false;
      const roundTrip = inTurn(() => oneRoundTrip(ctx15)).then((out) => {
        completed = true;
        return out;
      });
      await deadlines.waitForNext();
      ok(hungReads === 1, "§15/CONTROL: the round-trip really issued the store read that never answers");
      ok(completed === false, "§15/CONTROL: it remains pending until the store deadline fires");

      await deadlines.fireNext();
      const out = await roundTrip;
      ok(out.backendCalls === 1, "§15: 🔴 the model round-trip PROCEEDS when a hung store reaches its deadline");
      ok(out.text === undefined, "§15: …and it is a real model call, not a turn-ending stub");
    });
  } finally {
    (store as unknown as Record<string, unknown>)["getTaskResult"] = realGet;
    (store as unknown as Record<string, unknown>)["putTaskResult"] = realPut;
  }

  const healthy = await inTurn(() => oneRoundTrip(ctx15));
  ok(healthy.backendCalls === 1, "§15/CONTROL: with the store answering again, the round-trip is unchanged");
}

{
  const pair = turnPairKey("session-16", "turn_1600");
  await deleteTurnState(pair);

  const realPut = store.putTaskResult.bind(store);
  const realDelete = store.deleteTaskResult.bind(store);
  let releaseSlowPut = deferred();
  let slowPutStarted = deferred();
  let twoPutsSettled = deferred();
  let deleteSettled = deferred();
  let settled = 0;
  let slowPutsLeft = 1;
  (store as unknown as Record<string, unknown>)["putTaskResult"] = async (...args: Parameters<typeof realPut>): Promise<void> => {
    if (slowPutsLeft > 0) {
      slowPutsLeft -= 1;
      slowPutStarted.resolve();
      await releaseSlowPut.promise;
    }
    await realPut(...args);
    settled += 1;
    if (settled === 2) twoPutsSettled.resolve();
  };
  (store as unknown as Record<string, unknown>)["deleteTaskResult"] = async (...args: Parameters<typeof realDelete>): Promise<boolean> => {
    const out = await realDelete(...args);
    settled += 1;
    deleteSettled.resolve();
    return out;
  };
  try {
    await withControlledStoreDeadlines(async (deadlines) => {
      const first = writeTurnState(pair, { steps: 10 });
      await slowPutStarted.promise;
      await deadlines.fireNext();
      await first;
      ok(settled === 0, "§16/PRECONDITION: the first write returned at its deadline while the store call was still held open");

      const second = writeTurnState(pair, { steps: 11, stoppedAck: true });
      await deadlines.fireNext();
      await second;
      ok(settled === 0, "§16: 🔴 the queued caller returns at its own deadline without overtaking the held predecessor");

      releaseSlowPut.resolve();
      await twoPutsSettled.promise;
    });
    const final = await readTurnState(pair);
    ok(final?.steps === 11, `§16: 🔴 the row holds the SECOND write's count — an abandoned write does not rewind it (read ${String(final?.steps)})`);
    ok(final?.stoppedAck === true, "§16: 🔴 …and the stand-down valve stays SPENT — the un-spent read is one more post into a conversation the person asked the seat to leave");

    slowPutsLeft = 1;
    settled = 0;
    releaseSlowPut = deferred();
    slowPutStarted = deferred();
    deleteSettled = deferred();
    await withControlledStoreDeadlines(async (deadlines) => {
      const slowWrite = writeTurnState(pair, { steps: 12 });
      await slowPutStarted.promise;
      await deadlines.fireNext();
      await slowWrite;
      const deletion = deleteTurnState(pair);
      await deadlines.fireNext();
      await deletion;
      ok(settled === 0, "§16/PRECONDITION: the delete returned at its deadline without overtaking the held write");
      releaseSlowPut.resolve();
      await deleteSettled.promise;
    });
    const afterDelete = await readTurnState(pair);
    ok(afterDelete?.steps === 0, `§16: 🔴 a delete issued after an abandoned write wins — the row is GONE, not resurrected (read ${JSON.stringify(afterDelete)})`);
  } finally {
    (store as unknown as Record<string, unknown>)["putTaskResult"] = realPut;
    (store as unknown as Record<string, unknown>)["deleteTaskResult"] = realDelete;
  }

  {
    const pair2 = turnPairKey("session-16", "turn_1602");
    const realPut = store.putTaskResult.bind(store);
    const realGet = store.getTaskResult.bind(store);
    let slowPutsLeft = 0;
    let slowPutStarted = deferred();
    let releaseSlowPut = deferred();
    let slowPutSettled = deferred();
    let readsIssued = 0;
    (store as unknown as Record<string, unknown>)["putTaskResult"] = async (...args: Parameters<typeof realPut>): Promise<void> => {
      if (slowPutsLeft > 0) {
        slowPutsLeft -= 1;
        slowPutStarted.resolve();
        await releaseSlowPut.promise;
      }
      await realPut(...args);
      slowPutSettled.resolve();
    };
    (store as unknown as Record<string, unknown>)["getTaskResult"] = async (...args: Parameters<typeof realGet>): Promise<string | null> => {
      readsIssued += 1;
      return realGet(...args);
    };
    try {
      await deleteTurnState(pair2);
      await writeTurnState(pair2, { steps: 5 });
      ok((await readTurnState(pair2))?.steps === 5, "§16/PRECONDITION: the row is staged at steps 5 with a healthy store");

      const readsBefore = readsIssued;
      let stored: Awaited<ReturnType<typeof readTurnState>> = undefined;
      await withControlledStoreDeadlines(async (deadlines) => {
        slowPutsLeft = 1;
        slowPutStarted = deferred();
        releaseSlowPut = deferred();
        slowPutSettled = deferred();
        const slowWrite = writeTurnState(pair2, { steps: 5, stoppedAck: true });
        await slowPutStarted.promise;
        await deadlines.fireNext();
        await slowWrite;

        const queuedRead = readTurnState(pair2);
        await deadlines.waitForNext();
        ok(readsIssued === readsBefore, "§16/PRECONDITION: the successor read has not overtaken the held write");
        await deadlines.fireNext();
        stored = await queuedRead;

        releaseSlowPut.resolve();
        await slowPutSettled.promise;
      });
      const final = await readTurnState(pair2);
      ok(
        final?.stoppedAck === true,
        `§16: 🔴 a read cannot observe bytes an abandoned write is about to replace — the valve stays SPENT (read ${JSON.stringify(final)}). RED with the READ off the chain: the fast read returns {steps:5}, its writer spreads that, and the chain lands {steps:6} last`,
      );
      ok(stored === undefined, "§16: …because the queued read lost its OWN deadline race and answered `undefined`, so the writer skipped a row it had not seen");
    } finally {
      (store as unknown as Record<string, unknown>)["putTaskResult"] = realPut;
      (store as unknown as Record<string, unknown>)["getTaskResult"] = realGet;
      await deleteTurnState(pair2);
    }
  }

  const healthyPair = turnPairKey("session-16", "turn_1601");
  await deleteTurnState(healthyPair);
  await writeTurnState(healthyPair, { steps: 10 });
  await writeTurnState(healthyPair, { steps: 11, stoppedAck: true });
  const healthy = await readTurnState(healthyPair);
  ok(healthy?.steps === 11 && healthy.stoppedAck === true, "§16/CONTROL: against a healthy store the second write is what the row holds");
  await deleteTurnState(healthyPair);
}

{
  _resetTurnCloseoutForTest();
  const inTurn = newSession();
  const openThread = "1757400560.001700";
  const w = await wake("C_FORCED_LOOP", openThread);
  const ctx = ctxFor(w, "turn_1700", "turn-closeout-test", openThread);
  const partition = resolvePartition(ctx);
  await markThreadEngaged(partition, openThread, new Date().toISOString(), { participating: true });
  ok((await isThreadStopped(partition, openThread)) === false, "§17/CONTROL: this thread carries NO stored stop, so nothing below is the OPE-1520 arm wearing this leg's name");

  const before = posted.length;
  const armed = arm(ctx)!;
  const post = (text: string, force?: boolean): Promise<{ posted?: boolean; note?: string; error?: string }> =>
    inTurn(() =>
      armed
        .execute({ text, wake: w, done: true, ...(force === true ? { force: true } : {}) }, ctx)
        .then((r) => r as { posted?: boolean; note?: string })
        .catch((e: unknown) => ({ error: String(e) })),
    );

  const first = await post("The answer.");
  ok(first.posted === true, "§17: the first `done:true` reply posts and marks the wake answered");
  const second = await post("The answer, said again.", true);
  ok(second.posted === true, "§17: the first OVERRIDE posts — the ruling keeps one possible");
  ok(
    turnCloseoutTripped("turn-closeout-test", "turn_1700") === false,
    `§17/CONTROL: 🔴 and it arms NOTHING. The limit is ${FORCED_OVERRIDE_TURN_LIMIT}, so a single time-critical override never costs the turn its remaining steps`,
  );

  const third = await post("The answer, said a third time.", true);
  ok(third.posted === true, "§17: 🔴 the SECOND override posts TOO — the loop is ended by ending the turn, never by refusing the message");
  ok(posted.length === before + 3, "§17/ROOM: all three messages are in the room. This is the assertion that keeps the fix inside the rule");
  const latch = turnCloseoutFor("turn-closeout-test", "turn_1700");
  ok(latch?.reason === REPLY_FORCED_LOOP_REASON, `§17: …and the repeat armed the closeout under its OWN reason (saw ${latch?.reason ?? "nothing"})`);

  const after = await inTurn(() => oneRoundTrip(ctx));
  ok(after.backendCalls === 0, "§17: 🔴 so the NEXT model round-trip ends the turn instead of posting a fourth, fifth and fortieth time");
  ok((after.text ?? "").includes(REPLY_FORCED_LOOP_REASON), "§17: …and the ending names the repeated override as its reason, so the transcript says why");
  ok(
    !(after.text ?? "").includes("refused a further attempt to speak"),
    "§17/COPY: 🔴 the stub does not claim a refusal — on THIS arm the post landed, and copy the session reads back must not say otherwise",
  );

  await settle();
  const rows = (await readAudit({ org: ORG, action: STEP_BOUNDARY_ACTION })).filter(
    (r) => ((r.detail ?? {}) as Record<string, unknown>)["turnId"] === "turn_1700",
  );
  ok(rows.length === 1, "§17/AUDIT: one `turn.step_boundary` row for the turn ending");
  ok(
    ((rows[0]?.detail ?? {}) as Record<string, unknown>)["reason"] === REPLY_FORCED_LOOP_REASON,
    "§17/AUDIT: …naming the repeated override, so this ending is countable apart from a refusal-armed one",
  );
}

{
  _resetTurnCloseoutForTest();
  const inTurn = newSession();
  const openThread = "1757400560.001800";
  const w = await wake("C_OPEN_WAKE_LOOP", openThread);
  const ctx = ctxFor(w, "turn_1800", "turn-closeout-test", openThread);
  const partition = resolvePartition(ctx);
  await markThreadEngaged(partition, openThread, new Date().toISOString(), { participating: true });

  const before = posted.length;
  const armed = arm(ctx)!;
  const seat = tailWindowFor({ org: ORG, domainKey: DOMAIN, surfaceKey: SURFACE, rawToken: `unified:${TOKEN}`, platform: "slack" });
  ok(seat !== null, "§18/CONTROL: the fixture's token is a STANDING seat, the only grain that files a ring");
  const part = (text: string, force?: boolean): Promise<{ posted?: boolean; note?: string; error?: string }> =>
    inTurn(() => {
      seedTailWindow(seat);
      return armed
        .execute({ text, wake: w, done: false, ...(force === true ? { force: true } : {}) }, ctx)
        .then((r) => r as { posted?: boolean; note?: string })
        .catch((e: unknown) => ({ error: String(e) }));
    });

  const p1 = await part("Part one.");
  const p2 = await part("Part two.", true);
  const p3 = await part("Part three.", true);
  ok(p1.posted === true && p2.posted === true && p3.posted === true, "§18: all three `done:false` parts POST — nothing is blocked");
  ok(posted.length === before + 3, "§18/ROOM: and all three are in the room");
  ok(
    p3.note!.includes("This wake stays OPEN"),
    "§18/CONTROL: 🔴 the wake really is OPEN on the call that armed the latch — this is the state finding 2 is about",
  );

  const latch = turnCloseoutFor("turn-closeout-test", "turn_1800");
  ok(latch?.reason === REPLY_FORCED_LOOP_REASON, `§18: the repeated override armed the latch with the wake open (saw ${latch?.reason ?? "nothing"})`);
  const after = await inTurn(() => oneRoundTrip(ctx));
  ok(after.backendCalls === 0, "§18: the turn ends on the next round-trip, so a `done:false` loop has a terminator too");
  ok(
    !(after.text ?? "").includes("closed its reply obligation"),
    "§18/COPY: 🔴 the stub does NOT claim the turn had closed its reply obligation — false here, in a text the session reads back",
  );
  ok(
    !(after.text ?? "").includes("refused a further attempt to speak"),
    "§18/COPY: …and does not claim a refusal either — the post landed",
  );

  const row = await store.getUnifiedWakeRecord(ORG, w);
  ok(row !== null && row.answeredAt === undefined, "§18: 🔴 the wake stays PENDING — ending the turn defers the rest of the answer, it does not drop it");
}

rmSync(dir, { recursive: true, force: true });

console.log(`✓ turn closeout boundary: ${passed} assertions passed (turn ends within one round-trip, budget-independent, open wake untouched, stand-down silences the rest of the turn, duplicate valve intact, redundant no_reply, one audit row naming the reason, session keying, fail-open, survives an instance change, the stand-down gate reads the CONVERSATION not the wake id, the valve survives an instance change, a sessionless turn has no durable half, a hung store never stalls a round-trip, an abandoned write cannot overtake its successor, a repeated forced override ends the turn without blocking its post)`);
