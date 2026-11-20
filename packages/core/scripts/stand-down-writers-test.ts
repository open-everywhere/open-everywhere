// proves: REPLY-11

import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const dir = join(tmpdir(), `open-everywhere-stand-down-writers-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
delete process.env.OE_PLATFORM;

const { registerConfig } = await import("../agent/access/config.js");
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [{ name: "org", match: "org", admins: ["slack/T_WRITERS/U_WRITERS"] }] as never,
  loadSilos: () => [],
  domainsForSurface: () => [],
});

const { registerSlackTestBridge, registerSlackFixtureManifest, registerSlackFixtureCodec, registerSlackFixtureMapper, registerSlackFixturePostArm } =
  await import("./_slack-test-stubs.js");

type Call = { readonly method: string; readonly channel: string; readonly thread: string; readonly text: string };
const calls: Call[] = [];
const record = (method: string, args: Record<string, unknown>): void => {
  calls.push({
    method,
    channel: String(args["channel"] ?? args["channel_id"] ?? ""),
    thread: String(args["thread_ts"] ?? args["timestamp"] ?? args["ts"] ?? ""),
    text: String(args["text"] ?? args["markdown_text"] ?? ""),
  });
};
registerSlackTestBridge({
  form: async (method: string, body: string) => {
    record(method, Object.fromEntries(new URLSearchParams(body).entries()));
    return { ok: true, ts: `9100.${String(calls.length).padStart(6, "0")}` } as never;
  },
  readCall: async (method: string, args: Record<string, unknown>) => {
    record(method, args);
    return { ok: true } as never;
  },
} as never);
registerSlackFixtureManifest();
registerSlackFixtureCodec();
registerSlackFixtureMapper();
registerSlackFixturePostArm();

const { markThreadEngaged, isThreadStopped } = await import("../agent/channels/engagement.js");
const { resolvePartition } = await import("../agent/memory/partition.js");
const { registerUnifiedWakeTarget } = await import("../agent/channels/unified-window.js");
const { recordThreadOwner } = await import("../agent/channels/thread-ownership.js");
const { recordThreadSeatOpen } = await import("../agent/channels/thread-seat-state.js");
const { formatWindowToken, threadSeatWindowId } = await import("../agent/channels/window-key.js");
const { unifiedDomainSessionKey } = await import("../agent/channels/unified-supervisor.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { STAND_DOWN_VERB_REFUSED_ACTION } = await import("../agent/channels/stand-down-gate.js");
const { resolveWindowGated } = await import("../agent/access/window-gated.js");
const { postSessionNoteUnlessStoodDown, sessionNoteSuffix } = await import("../agent/tools/open_pull_request.js");
const { announceHalt, haltModelMessage, haltConfirmation } = await import("../agent/tools/halt.js");

interface Exec {
  readonly execute: (input: Record<string, unknown>, ctx: unknown) => Promise<unknown>;
}
const standDown = (await import("../agent/tools/stand_down.js")).default as unknown as Exec;
const completeThread = (await import("../agent/tools/complete_thread.js")).default;
const messageThreadSeat = (await import("../agent/tools/message_thread_seat.js")).default;

const gated = async (tool: unknown, ctx: unknown): Promise<Exec> => {
  const a = (await resolveWindowGated(tool as never, ctx as never)) as unknown as Exec | null;
  assert.ok(a !== null, "fixture: the window-gated tool arms on this context");
  return a;
};

const require = createRequire(import.meta.url);
const eveRoot = dirname(require.resolve("eve/package.json"));
const { ContextContainer, contextStorage } = await import(pathToFileURL(join(eveRoot, "dist/src/context/container.js")).href);
const newSession = (): (<T>(fn: () => Promise<T>) => Promise<T>) => {
  const c = new ContextContainer();
  return (fn) => contextStorage.run(c, fn);
};

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

type Outcome = { readonly ok: boolean; readonly value?: unknown; readonly error?: string };
async function attempt(fn: () => Promise<unknown>): Promise<Outcome> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const ORG = "default";
const CHAN = "C_WRITERS";
const DOMAIN = "writers";
const STOPPED = "1758000000.000100";
const HOLDER = "1758000000.000400";
const OPEN = "1758000000.000200";
const OPEN2 = "1758000000.000300";
const STANDING = formatWindowToken({ domain: DOMAIN, windowId: DOMAIN, generation: 1 });
const seatTokenOf = (thread: string): string => formatWindowToken({ domain: DOMAIN, windowId: threadSeatWindowId(`slack/${CHAN}`, thread), generation: 1 });

function threadCtx(threadTs: string, sessionId: string, turnId: string, extra: Record<string, string> = {}) {
  return {
    channel: { kind: "slack" },
    session: {
      id: sessionId,
      turn: { id: turnId },
      auth: {
        current: {
          attributes: { team_id: "T_WRITERS", channel_id: CHAN, thread_ts: threadTs, channel_type: "channel", user_id: "U_WRITERS", ...extra },
          principalId: "U_WRITERS",
          principalType: "slack-user",
        },
      },
    },
  };
}

const store = getOperationalStore();
const T0 = new Date().toISOString();
await store.rotateChannelSession(ORG, unifiedDomainSessionKey(DOMAIN), STANDING, T0);

async function openSeat(thread: string): Promise<string> {
  const origin = { platform: "slack" as const, channelId: CHAN, threadTs: thread };
  const ref = { channelKey: `slack/${CHAN}`, threadKey: thread };
  const seat = seatTokenOf(thread);
  await recordThreadOwner(store, ORG, ref, seat, T0);
  await recordThreadSeatOpen(store, ORG, ref, { seatToken: seat, parentRegistryKey: unifiedDomainSessionKey(DOMAIN), origin, atIso: T0 });
  return seat;
}

let wakes = 0;
async function wakeIn(thread: string, token: string): Promise<string> {
  const wakeId = `wake-writers-${++wakes}`;
  await registerUnifiedWakeTarget(store, ORG, wakeId, { platform: "slack", channelId: CHAN, threadTs: thread }, new Date().toISOString(), token);
  return wakeId;
}

async function seatCtx(thread: string, sessionId: string, turnId: string) {
  const seat = seatTokenOf(thread);
  return threadCtx(thread, sessionId, turnId, { oe_window_token: seat, oe_grain: "thread", oe_wake_id: await wakeIn(thread, seat) });
}

async function supervisorCtx(thread: string, sessionId: string, turnId: string) {
  return threadCtx(thread, sessionId, turnId, { oe_window_token: STANDING, oe_grain: "standing", oe_fire_unattended: "true", oe_wake_id: await wakeIn(thread, STANDING) });
}

const visibleIn = (thread: string): Call[] =>
  calls.filter((c) => c.thread === thread && (c.method === "chat.postMessage" || c.method === "reactions.add" || c.method === "chat.update"));

const standerCtx = threadCtx(STOPPED, "writers-stander", "turn_s1");
const partition = resolvePartition(standerCtx as never);
for (const t of [STOPPED, OPEN, OPEN2, HOLDER]) await markThreadEngaged(partition, t, T0, { participating: true });
const stop = (await newSession()(() => standDown.execute({ reason: "asked me to stop" }, standerCtx))) as { standingDown: boolean };
ok(stop.standingDown === true, "WIRING: the real `stand_down` stopped the thread");
ok((await isThreadStopped(partition, STOPPED)) && !(await isThreadStopped(partition, OPEN)) && !(await isThreadStopped(partition, OPEN2)), "WIRING: only STOPPED carries the stop");

console.log("§1 complete_thread: no summary post and no done reaction in a thread that stood down");
{
  await openSeat(STOPPED);
  const ctx = await seatCtx(STOPPED, "writers-seat-stopped", "turn_t1");
  const before = visibleIn(STOPPED).length;
  const out = await newSession()(() => attempt(async () => (await gated(completeThread, ctx)).execute({ summary: "Shipped the fix." }, ctx)));
  ok(out.ok, `§1: complete_thread still completes in a stopped thread (${out.error ?? "ok"})`);
  const note = String((out.value as { note?: string } | undefined)?.note ?? "");
  ok(visibleIn(STOPPED).length === before, `🔴 §1/ROOM: nothing reached the stopped thread — no summary post, no done reaction (${JSON.stringify(visibleIn(STOPPED).slice(before))})`);
  ok(/stood down/.test(note) && /no done reaction/.test(note), `§1: the note tells the seat the thread stood down (${note})`);
  ok((await store.getThreadSeatState(ORG, `slack/${CHAN}`, STOPPED))?.state === "completed", "§1: the seat is still recorded as completed (the release is not visible)");
  const rows = (await readAudit({ org: ORG, action: STAND_DOWN_VERB_REFUSED_ACTION })) as { detail?: Record<string, unknown> }[];
  ok(rows.some((r) => r.detail?.["verb"] === "complete_thread" && r.detail?.["withheld"] === true), "§1/AUDIT: the withheld completion writes a stand_down.verb_refused row with withheld: true");

  await openSeat(OPEN);
  const ctlCtx = await seatCtx(OPEN, "writers-seat-open", "turn_t2");
  const ctl = await newSession()(() => attempt(async () => (await gated(completeThread, ctlCtx)).execute({ summary: "Shipped the other fix." }, ctlCtx)));
  ok(ctl.ok, `§1 control: complete_thread completes in an open thread (${ctl.error ?? "ok"})`);
  const seen = visibleIn(OPEN);
  ok(seen.some((c) => c.method === "chat.postMessage" && c.text.includes("Shipped the other fix.")), `negative control §1: the summary IS posted in a thread that did not stand down (${JSON.stringify(seen)})`);
  ok(seen.some((c) => c.method === "reactions.add"), "negative control §1: …and the done reaction IS placed");
}

console.log("§2 message_thread_seat: no mirror post into a thread that stood down");
{
  await openSeat(STOPPED);
  const bound = await supervisorCtx(STOPPED, "writers-sup-a", "turn_m1");
  const before = visibleIn(STOPPED).length;
  const a = await newSession()(() => attempt(async () => (await gated(messageThreadSeat, bound)).execute({ text: "Please hold the deploy.", mirror: true }, bound)));
  ok(!a.ok && /stand down/i.test(a.error ?? ""), `🔴 §2: a mirror into the turn's own stopped thread is REFUSED (${a.error ?? "posted"})`);
  ok(visibleIn(STOPPED).length === before, "🔴 §2/ROOM: …and nothing reached the stopped thread");

  await openSeat(OPEN2);
  const other = await supervisorCtx(OPEN2, "writers-sup-b", "turn_m2");
  const b = await newSession()(() => attempt(async () => (await gated(messageThreadSeat, other)).execute({ thread: STOPPED, text: "Please hold the deploy.", mirror: true }, other)));
  ok(!b.ok && /asked to stand down/i.test(b.error ?? ""), `🔴 §2: a mirror that NAMES a stopped thread from an open one is REFUSED (${b.error ?? "posted"})`);
  ok(/Your own conversation is not affected/.test(b.error ?? ""), "§2: …with the target-only text, which leaves the open conversation alone");
  ok(visibleIn(STOPPED).length === before, "🔴 §2/ROOM: …and nothing reached the stopped thread");

  const c = await newSession()(() => attempt(async () => (await gated(messageThreadSeat, other)).execute({ text: "Please hold the deploy.", mirror: true }, other)));
  ok(c.ok, `negative control §2: a mirror into a thread that did not stand down still runs (${c.error ?? "ok"})`);
  ok(visibleIn(OPEN2).some((x) => x.method === "chat.postMessage" && x.text.includes("Please hold the deploy.")), "negative control §2: …and the mirror IS posted there");
}

console.log("§3 open_pull_request: no session-approved outcome note into a conversation that stood down");
{
  const ctx = threadCtx(STOPPED, "writers-pr-a", "turn_p1");
  const before = visibleIn(STOPPED).length;
  const out = await newSession()(() => postSessionNoteUnlessStoodDown(ctx as never, "slack", CHAN, STOPPED, "Opened PR #7"));
  ok(out === "withheld", `🔴 §3: the outcome note is WITHHELD in a stopped conversation (${out})`);
  ok(visibleIn(STOPPED).length === before, "🔴 §3/ROOM: …and nothing reached the stopped thread");
  const ctlCtx = threadCtx(OPEN, "writers-pr-b", "turn_p2");
  const ctl = await newSession()(() => postSessionNoteUnlessStoodDown(ctlCtx as never, "slack", CHAN, OPEN, "Opened PR #8"));
  ok(ctl === "posted" && visibleIn(OPEN).some((x) => x.text.includes("Opened PR #8")), "negative control §3: the note IS posted in a conversation that did not stand down");
}

console.log("§4 halt: the halt still takes effect, but no confirmation is posted into a conversation that stood down");
{
  const posted: string[] = [];
  const post = async (_t: unknown, text: string): Promise<string> => {
    posted.push(text);
    return "9100.999999";
  };
  const ctx = threadCtx(STOPPED, "writers-halt-a", "turn_h1");
  const out = await newSession()(() => announceHalt(ctx as never, "surface", { post }));
  ok(out === "withheld", `🔴 §4: the halt confirmation is WITHHELD in a stopped conversation (${out})`);
  ok(posted.length === 0, "🔴 §4/ROOM: …and nothing was posted");
  ok(!haltModelMessage(out, "surface").includes(haltConfirmation("surface")), "§4: …and the model is not handed the confirmation to post itself");
  const ctlCtx = threadCtx(OPEN, "writers-halt-b", "turn_h2");
  const ctl = await newSession()(() => announceHalt(ctlCtx as never, "surface", { post }));
  ok(ctl === "posted" && posted.length === 1, `negative control §4: the confirmation IS posted in a conversation that did not stand down (${ctl})`);
}

console.log("§5 the turn that stood down still owes its one acknowledgement, and the withheld steers say so");
{
  const holderCtx = threadCtx(HOLDER, "writers-holder", "turn_k1");
  const inTurn = newSession();
  const held = (await inTurn(() => standDown.execute({ reason: "asked me to stop" }, holderCtx))) as { standingDown: boolean };
  ok(held.standingDown === true, "WIRING §5: this turn stood the HOLDER thread down itself");
  let posts = 0;
  const post = async (): Promise<string> => {
    posts++;
    return "9100.999998";
  };
  const halt = await inTurn(() => announceHalt(holderCtx as never, "surface", { post }));
  ok(halt === "withheld-ack-owed" && posts === 0, `🔴 §5: the holder's halt confirmation is withheld, and the outcome says the acknowledgement is still owed (${halt})`);
  ok(/post it with `reply`/.test(haltModelMessage(halt, "surface")) && !haltModelMessage(halt, "surface").includes(haltConfirmation("surface")), "🔴 §5: …so the model is told to post its one acknowledgement, not the confirmation");
  ok(!/`reply`/.test(haltModelMessage("withheld", "surface")), "negative control §5: a turn that does NOT hold the acknowledgement is never steered to `reply`");
  const note = await inTurn(() => postSessionNoteUnlessStoodDown(holderCtx as never, "slack", CHAN, HOLDER, "Opened PR #9"));
  ok(note === "withheld-ack-owed" && /post it with `reply`/.test(sessionNoteSuffix(note)), `🔴 §5: the holder's PR note is withheld, and its steer names \`reply\` (${note})`);
  ok(!/`reply`/.test(sessionNoteSuffix("withheld")) && sessionNoteSuffix("posted") === "", "negative control §5: a non-holder's withheld note never names `reply`, and a posted note adds nothing");
}

console.log(`stand-down-writers-test: ${n} assertions passed`);
