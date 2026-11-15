// proves: DELG-10, DELG-11, DELG-24, DELG-25, DELG-47, DELG-48, DELG-50, DELG-51

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-thread-seat-close-")), "ops.sqlite3");

import { closeThreadSeat, sweepIdleThreadSeats, renderThreadSeatHandBack, threadRootMessageOf, THREAD_SEAT_IDLE_MS, THREAD_DONE_REACTION, type ThreadSeatCloseDeps } from "../agent/channels/thread-seat-close.js";
import { recordThreadSeatOpen, touchThreadSeatActivity } from "../agent/channels/thread-seat-state.js";
import { recordThreadOwner, resolveThreadOwner, THREAD_OWNER_TTL_MS } from "../agent/channels/thread-ownership.js";
import { unifiedThreadRef, type UnifiedWakeOrigin } from "../agent/channels/unified-window.js";
import { formatWindowToken, threadSeatWindowId } from "../agent/channels/window-key.js";
import { unifiedDomainSessionKey } from "../agent/channels/unified-supervisor.js";
import { getOperationalStore } from "../agent/operational/provider.js";
import { completionPostFor, completeThreadNote, THREAD_DONE_LINE } from "../agent/tools/complete_thread.js";
import { renderThreadSeatBrief } from "../agent/tools/spawn_thread_session.js";
import { leanSeatRefusal } from "../agent/access/window-gated.js";
import { readThreadSeatNote } from "../agent/tools/read_thread_seat.js";
import { registerSlackFixtureCodec } from "./_slack-test-stubs.js";

registerSlackFixtureCodec();

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const ORG = "acme";
const DOMAIN = "payments";
const store = getOperationalStore();
const PARENT_KEY = unifiedDomainSessionKey(DOMAIN);
const T0 = "2026-10-01T09:00:00.000Z";

interface Recorder {
  handBacks: { token: string; domain: string; origin: UnifiedWakeOrigin; message: string }[];
  reactions: { platform: string; channelId: string; messageId: string; emoji: string }[];
  audits: { action: string; detail: Record<string, unknown> }[];
}

function deps(nowIso: string, rec: Recorder): ThreadSeatCloseDeps & { store: typeof store } {
  return {
    store,
    handBack: async (h) => {
      rec.handBacks.push({ ...h });
      return true;
    },
    react: async (platform, ref, emoji) => {
      rec.reactions.push({ platform, channelId: ref.channelId, messageId: ref.messageId, emoji: emoji.slackName });
      return true;
    },
    appendAudit: async (row) => {
      rec.audits.push({ action: row.action, detail: (row.detail ?? {}) as Record<string, unknown> });
    },
    now: () => new Date(nowIso),
  };
}
const recorder = (): Recorder => ({ handBacks: [], reactions: [], audits: [] });

async function openSeat(origin: UnifiedWakeOrigin, generation: number, atIso: string): Promise<{ ref: ReturnType<typeof unifiedThreadRef>; seat: string }> {
  const ref = unifiedThreadRef(origin);
  const seat = formatWindowToken({ domain: DOMAIN, windowId: threadSeatWindowId(ref.channelKey, ref.threadKey), generation });
  await recordThreadOwner(store, ORG, ref, seat, atIso);
  await recordThreadSeatOpen(store, ORG, ref, { seatToken: seat, parentRegistryKey: PARENT_KEY, origin, atIso });
  return { ref, seat };
}

await store.rotateChannelSession(ORG, PARENT_KEY, formatWindowToken({ domain: DOMAIN, windowId: DOMAIN, generation: 1 }), T0);
const PARENT_LIVE = formatWindowToken({ domain: DOMAIN, windowId: DOMAIN, generation: 2 });
await store.rotateChannelSession(ORG, PARENT_KEY, PARENT_LIVE, T0);

console.log("1. a completed close: record, release, hand back to the LIVE parent, done reaction on the root:");
{
  const origin: UnifiedWakeOrigin = { platform: "slack", channelId: "C1", threadTs: "170.5" };
  const { ref, seat } = await openSeat(origin, 1, T0);
  const rec = recorder();
  const out = await closeThreadSeat({ org: ORG, ref, reason: "completed", report: "Shipped the fix in #42.", origin, seatToken: seat }, deps("2026-10-01T12:00:00.000Z", rec));
  eq(out, { recorded: true, closedNow: true, foreign: false, cleared: true, handedBack: true, reaction: "placed", priorState: "open" }, "the close did every step");
  eq((await store.getThreadSeatState(ORG, ref.channelKey, ref.threadKey))?.state, "completed", "the record reads completed");
  eq(await resolveThreadOwner(store, ORG, ref), null, "the thread is released: later messages wake the standing seat");
  eq(rec.handBacks.length, 1, "exactly one hand-back");
  eq(rec.handBacks[0].token, PARENT_LIVE, "🔴 the hand-back wakes the parent's LIVE generation, not the retired one that spawned the seat");
  eq(rec.handBacks[0].domain, DOMAIN, "…in the parent's domain");
  ok(rec.handBacks[0].message.includes("finished its thread and handed it back"), "the hand-back says the thread finished");
  ok(rec.handBacks[0].message.includes("The seat's own report:\nShipped the fix in #42."), "the seat's report rides VERBATIM inside the host's hand-back");
  ok(rec.handBacks[0].message.includes(`Opened: ${T0}.`), "the hand-back states the recorded facts (when the thread opened)");
  eq(rec.reactions, [{ platform: "slack", channelId: "C1", messageId: "170.5", emoji: THREAD_DONE_REACTION.slackName }], "🔴 the done reaction lands on the thread's ROOT message (the thread ts)");
  eq(rec.audits.map((a) => a.action), ["thread_seat.completed"], "one audit row, thread_seat.completed");
  eq(rec.audits[0].detail.reaction, "placed", "audit: the reaction outcome");
  ok(!JSON.stringify(rec.audits[0].detail).includes("Shipped the fix"), "audit: no report TEXT in the row");

  const again = recorder();
  const second = await closeThreadSeat({ org: ORG, ref, reason: "completed", report: "a later, different report", origin, seatToken: seat }, deps("2026-10-01T13:00:00.000Z", again));
  eq(second.closedNow, false, "3. a second close finds the record already closed");
  eq(again.handBacks.length + again.reactions.length, 0, "3. …and hands nothing back and reacts nothing");
  eq((await store.getThreadSeatState(ORG, ref.channelKey, ref.threadKey))?.report, "Shipped the fix in #42.", "3. …and the FIRST close's report stands");
}

console.log("2. 🔴 the hand-back is host-written: no report still tells the parent:");
{
  const origin: UnifiedWakeOrigin = { platform: "slack", channelId: "C1", threadTs: "171.5" };
  const { ref, seat } = await openSeat(origin, 1, T0);
  const rec = recorder();
  const out = await closeThreadSeat({ org: ORG, ref, reason: "completed", origin, seatToken: seat }, deps("2026-10-01T12:00:00.000Z", rec));
  eq(out.handedBack, true, "a completion with NO report still hands the thread back");
  ok(rec.handBacks[0].message.includes("The seat left no report."), "…and says so in the host's own words");
  eq(rec.audits[0].detail.hasReport, false, "audit: hasReport=false");
}

console.log("4. the idle sweep: a quiet thread expires with a hand-back; an active one does not:");
{
  const quiet: UnifiedWakeOrigin = { platform: "slack", channelId: "C2", threadTs: "200.1" };
  const active: UnifiedWakeOrigin = { platform: "slack", channelId: "C2", threadTs: "200.2" };
  const q = await openSeat(quiet, 1, "2026-10-01T00:00:00.000Z");
  const a = await openSeat(active, 1, "2026-10-01T00:00:00.000Z");
  ok(await touchThreadSeatActivity(store, ORG, a.ref, "2026-10-03T23:00:00.000Z"), "a message moves an open thread's activity stamp");
  const now = new Date(Date.parse("2026-10-01T00:00:00.000Z") + THREAD_SEAT_IDLE_MS + 60_000).toISOString();
  const rec = recorder();
  const swept = await sweepIdleThreadSeats(ORG, deps(now, rec));
  ok(swept.expired >= 1 && swept.handedBack === swept.expired, "the sweep expired the quiet thread and handed each one back");
  eq((await store.getThreadSeatState(ORG, q.ref.channelKey, q.ref.threadKey))?.state, "expired", "the quiet thread's record reads expired");
  eq(await resolveThreadOwner(store, ORG, q.ref), null, "…and its thread is released");
  eq((await store.getThreadSeatState(ORG, a.ref.channelKey, a.ref.threadKey))?.state, "open", "🔴 the ACTIVE thread is untouched — a thread somebody writes in never expires");
  eq(await resolveThreadOwner(store, ORG, a.ref), a.seat, "…and keeps its route");
  const quietBack = rec.handBacks.find((h) => h.origin.platform === "slack" && (h.origin as { threadTs?: string }).threadTs === "200.1");
  ok(quietBack !== undefined && quietBack.message.includes("went quiet, so the host closed it"), "the expired thread's hand-back says it went quiet");
  ok(quietBack !== undefined && quietBack.message.includes("Last activity: 2026-10-01T00:00:00.000Z."), "…and states when it was last active");
  eq(rec.reactions.length, 0, "🔴 NO done reaction on an expired thread — it did not finish");
  ok(rec.audits.every((x) => x.action === "thread_seat.closed" && x.detail.reason === "expired"), "every sweep row is thread_seat.closed, reason expired");
  const rerun = recorder();
  const swept2 = await sweepIdleThreadSeats(ORG, deps(now, rerun));
  eq(swept2.expired, 0, "a second sweep finds nothing left to expire");
}

console.log("5. a host `closed` close carries no done reaction:");
{
  const origin: UnifiedWakeOrigin = { platform: "slack", channelId: "C3", threadTs: "300.1" };
  const { ref, seat } = await openSeat(origin, 1, T0);
  const rec = recorder();
  const out = await closeThreadSeat({ org: ORG, ref, reason: "closed", seatToken: seat }, deps("2026-10-01T12:00:00.000Z", rec));
  eq(out.reaction, "not-owed", "a host close owes no done mark");
  eq(rec.reactions.length, 0, "…and places none");
  ok(rec.handBacks[0].message.includes("could no longer reach it"), "the hand-back says the host closed it");
  eq(rec.handBacks[0].origin, origin, "the hand-back is about the thread's recorded origin");
}

console.log("6. 🔴 a late close by an OLD seat never touches the thread a NEWER seat holds:");
{
  const origin: UnifiedWakeOrigin = { platform: "slack", channelId: "C4", threadTs: "400.1" };
  const { ref, seat: seatA } = await openSeat(origin, 1, T0);
  await closeThreadSeat({ org: ORG, ref, reason: "expired", seatToken: seatA }, deps("2026-10-05T00:00:00.000Z", recorder()));
  const { seat: seatB } = await openSeat(origin, 2, "2026-10-05T01:00:00.000Z");
  ok(seatB !== seatA, "fixture guard: B is a different seat token from A");
  const rec = recorder();
  const out = await closeThreadSeat({ org: ORG, ref, reason: "completed", report: "A's late report", origin, seatToken: seatA }, deps("2026-10-05T02:00:00.000Z", rec));
  eq({ closedNow: out.closedNow, foreign: out.foreign, cleared: out.cleared }, { closedNow: false, foreign: true, cleared: false }, "A's close changes nothing: the record names B");
  const row = await store.getThreadSeatState(ORG, ref.channelKey, ref.threadKey);
  eq([row?.state, row?.seatToken, row?.report], ["open", seatB, undefined], "🔴 B's record stays OPEN, naming B, with no report from A");
  eq(await resolveThreadOwner(store, ORG, ref), seatB, "🔴 …and B keeps its route");
  eq(rec.handBacks.length + rec.reactions.length, 0, "…and nobody is told a thread finished that B is still working");
}

console.log("6b. two RACING closes close the record once and hand back once:");
{
  const origin: UnifiedWakeOrigin = { platform: "slack", channelId: "C5", threadTs: "500.1" };
  const { ref, seat } = await openSeat(origin, 1, T0);
  const rec = recorder();
  const d = deps("2026-10-01T12:00:00.000Z", rec);
  const [a, b] = await Promise.all([
    closeThreadSeat({ org: ORG, ref, reason: "closed", seatToken: seat }, d),
    closeThreadSeat({ org: ORG, ref, reason: "closed", seatToken: seat }, d),
  ]);
  eq([a.closedNow, b.closedNow].filter(Boolean).length, 1, "🔴 exactly one of two concurrent closes closed the record");
  eq(rec.handBacks.length, 1, "🔴 …and the parent hears it once");
  const o2: UnifiedWakeOrigin = { platform: "slack", channelId: "C5", threadTs: "500.2" };
  const s2 = await openSeat(o2, 1, T0);
  const rec2 = recorder();
  const d2 = deps("2026-10-01T12:00:00.000Z", rec2);
  await Promise.all([
    closeThreadSeat({ org: ORG, ref: s2.ref, reason: "expired", seatToken: s2.seat }, d2),
    closeThreadSeat({ org: ORG, ref: s2.ref, reason: "completed", report: "done", origin: o2, seatToken: s2.seat }, d2),
  ]);
  eq((await store.getThreadSeatState(ORG, s2.ref.channelKey, s2.ref.threadKey))?.state, "completed", "sweep vs completion: the seat's completion is the final state, whichever lands first");
  ok(rec2.handBacks.length >= 1 && rec2.handBacks.length <= 2, "…with at most two hand-backs (the second one replaces the first)");
}

console.log("6c. a seat that finishes AFTER the idle sweep still hands its report back:");
{
  const origin: UnifiedWakeOrigin = { platform: "slack", channelId: "C6", threadTs: "600.1" };
  const { ref, seat } = await openSeat(origin, 1, T0);
  await closeThreadSeat({ org: ORG, ref, reason: "expired", seatToken: seat }, deps("2026-10-05T00:00:00.000Z", recorder()));
  const rec = recorder();
  const out = await closeThreadSeat({ org: ORG, ref, reason: "completed", report: "Long job done: #77.", origin, seatToken: seat }, deps("2026-10-05T03:00:00.000Z", rec));
  eq(out.closedNow, true, "🔴 the seat's own completion supersedes the host's expiry");
  const row = await store.getThreadSeatState(ORG, ref.channelKey, ref.threadKey);
  eq([row?.state, row?.report], ["completed", "Long job done: #77."], "…the record reads completed, with the seat's report kept");
  ok(rec.handBacks.length === 1 && rec.handBacks[0].message.includes("replaces that earlier hand-back") && rec.handBacks[0].message.includes("Long job done: #77."), "…the parent is told, and told it replaces the quiet-thread hand-back");
  eq(rec.reactions.length, 1, "…and the finished thread gets its done mark");
  const again = recorder();
  const rerun = await closeThreadSeat({ org: ORG, ref, reason: "completed", report: "Long job done: #77.", origin, seatToken: seat }, deps("2026-10-05T04:00:00.000Z", again));
  eq([rerun.closedNow, rerun.priorState, again.handBacks.length, again.reactions.length], [false, "completed", 0, 0], "a second completion by the same seat closes nothing and tells nobody twice");
  eq(completeThreadNote(rerun, "seat"), "This thread is already complete and handed back. Nothing more to do.", "🔴 …and the seat is told it is done, never asked to post again");
  const origin2: UnifiedWakeOrigin = { platform: "slack", channelId: "C6", threadTs: "600.2" };
  const s2 = await openSeat(origin2, 1, T0);
  await closeThreadSeat({ org: ORG, ref: s2.ref, reason: "closed", seatToken: s2.seat }, deps("2026-10-05T00:00:00.000Z", recorder()));
  const late = await closeThreadSeat({ org: ORG, ref: s2.ref, reason: "completed", report: "too late", origin: origin2, seatToken: s2.seat }, deps("2026-10-05T03:00:00.000Z", recorder()));
  eq(late.closedNow, false, "a completion after a HOST close does not reopen it");
  ok(completeThreadNote(late, "seat").includes("already closed this thread before you finished") && completeThreadNote(late, "seat").includes("not delivered"), "🔴 …and complete_thread tells the seat its summary was NOT delivered");
  ok(completeThreadNote({ recorded: true, closedNow: false, foreign: true, cleared: false, handedBack: false, reaction: "not-owed" }, "seat").includes("A newer thread seat holds this thread"), "…and names the newer-seat case");
  ok(completeThreadNote({ recorded: true, closedNow: true, foreign: false, cleared: true, handedBack: true, reaction: "placed" }, "host").includes("The standing seat has been told."), "negative control: a normal close says the standing seat was told");
}

console.log("7. the two clocks, and the root message per origin:");
ok(THREAD_SEAT_IDLE_MS + 24 * 60 * 60 * 1000 < THREAD_OWNER_TTL_MS, "a daily sweep closes a quiet thread (idle window + one tick) before the ownership TTL could drop it");
eq(threadRootMessageOf({ platform: "slack", channelId: "C1", threadTs: "1.1" }), { platform: "slack", channelId: "C1", messageId: "1.1" }, "slack: a threaded origin's root is its thread ts");
eq(threadRootMessageOf({ platform: "slack", channelId: "C1", replyAnchorTs: "2.2" }), { platform: "slack", channelId: "C1", messageId: "2.2" }, "slack: a top-level trigger a seat was spawned for is the root");
eq(threadRootMessageOf({ platform: "slack", channelId: "D1" }), undefined, "slack: an origin with neither (a DM, a routine) names no root");

console.log("8. complete_thread's in-thread completion, and the hand-back wording:");
eq(completionPostFor(true, "report"), undefined, "the seat posted this turn: that post IS the completion, the host adds nothing");
eq(completionPostFor(false, "Shipped."), "Shipped.", "the seat did not post: the host posts its report in the thread");
eq(completionPostFor(false, undefined), THREAD_DONE_LINE, "no post and no report: the host posts the fixed done line");
const base = { ref: { channelKey: "slack/C1", threadKey: "1.1" }, openedAt: T0, lastActiveAt: T0, closedAt: T0 };
ok(renderThreadSeatHandBack({ ...base, reason: "completed" }).includes("done reaction"), "completed: names the done mark");
ok(!renderThreadSeatHandBack({ ...base, reason: "expired" }).includes("done reaction"), "expired: claims no done mark");
ok(renderThreadSeatHandBack({ ...base, reason: "expired" }).includes("Nothing is owed to the room"), "every hand-back is ambient: nothing is owed to the room");
ok(readThreadSeatNote("expired", false, false).includes("went quiet"), "read_thread_seat names an expired close");
const brief = renderThreadSeatBrief("Fix the nightly job.");
ok(brief.includes("post the completion in this thread with `reply`, then call `complete_thread`") && brief.endsWith("Fix the nightly job."), "the opening brief tells a thread seat to finish visibly, and carries the caller's brief verbatim");
ok(!leanSeatRefusal("bash", "thread").includes("spawn_thread_session"), "🔴 OPE-2429: a thread seat's lean refusal never offers a hand-off it cannot make");
ok(leanSeatRefusal("bash", "standing").includes("spawn_thread_session"), "negative control: a standing seat's refusal names both sides of the decision");
ok(readThreadSeatNote("closed", false, true).includes("could no longer reach it"), "read_thread_seat names a host close");
ok(readThreadSeatNote("completed", false, true).includes("finished the thread"), "read_thread_seat names a completion");

console.log(`thread-seat-close-test: ${n} assertions passed`);
