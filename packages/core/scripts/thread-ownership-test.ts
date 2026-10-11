import assert from "node:assert/strict";
import {
  recordThreadOwner,
  resolveThreadOwner,
  clearThreadOwner,
  routeThreadMessage,
  isLiveThreadSeatOwner,
  THREAD_OWNER_TTL_MS,
  type ThreadOwnershipStore,
} from "../agent/channels/thread-ownership.js";
import { taskWindowId, threadSeatWindowId, formatWindowToken } from "../agent/channels/window-key.js";
import completeThread, { isOwnTokenThreadSeat } from "../agent/tools/complete_thread.js";
import { resolveWindowGated } from "../agent/access/window-gated.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const taskTokenFor = (channelKey: string, threadKey: string, gen: number) =>
  formatWindowToken({ domain: "payments", windowId: taskWindowId(channelKey, threadKey), generation: gen });

console.log("1. routeThreadMessage decision:");
const OWNER = taskTokenFor("slack/C1", "170.5", 3);
eq(routeThreadMessage(OWNER, 3), { kind: "task", token: OWNER, grain: "task" }, "owned thread (live task token, matching generation) ⇒ route the TASK session (grain task)");
eq(routeThreadMessage(OWNER), { kind: "task", token: OWNER, grain: "task" }, "owned thread, generation unspecified ⇒ route the TASK session (no staleness check)");
eq(routeThreadMessage(null), { kind: "standing" }, "unowned thread (null) ⇒ route the STANDING seat");
eq(routeThreadMessage(null, 3), { kind: "standing" }, "a non-thread channel message (no lookup ⇒ null) ⇒ STANDING");
eq(routeThreadMessage(OWNER, 4), { kind: "standing" }, "STALE generation (owner from gen 3, live gen 4) ⇒ STANDING (rotation happened; row lazily reaped)");
eq(routeThreadMessage("oe-dom:payments:oe-sup:g3"), { kind: "standing" }, "a STANDING (non-owner) token stored as owner ⇒ STANDING (fail-safe, never route to a non-owner token)");
eq(routeThreadMessage("garbage"), { kind: "standing" }, "an unparseable owner token ⇒ STANDING (fail-safe)");
const SEAT_OWNER = formatWindowToken({ domain: "payments", windowId: "s/slack_C1/170.5", generation: 3 });
eq(routeThreadMessage(SEAT_OWNER, 3), { kind: "task", token: SEAT_OWNER, grain: "thread" }, "a THREAD-SEAT owner (s/… token, live generation) ⇒ route the SEAT session (grain thread)");
eq(routeThreadMessage(SEAT_OWNER, 4), { kind: "task", token: SEAT_OWNER, grain: "thread" }, "a thread seat from an EARLIER parent generation ⇒ STILL routes the SEAT (a rotation does not orphan it)");
eq(routeThreadMessage(SEAT_OWNER, 9, "payments"), { kind: "task", token: SEAT_OWNER, grain: "thread" }, "…however many rotations later, while the domain matches");
eq(routeThreadMessage(SEAT_OWNER, 4, "treasury"), { kind: "standing" }, "…but a thread seat minted into ANOTHER domain ⇒ STANDING (the domain check still applies to seats)");
ok(isLiveThreadSeatOwner(SEAT_OWNER, "payments"), "isLiveThreadSeatOwner: a thread seat in the same domain is live, whatever its generation");
ok(!isLiveThreadSeatOwner(SEAT_OWNER, "treasury"), "isLiveThreadSeatOwner: a thread seat in another domain is not");
ok(!isLiveThreadSeatOwner(OWNER, "payments"), "isLiveThreadSeatOwner: a TASK owner is never a live thread seat");
ok(!isLiveThreadSeatOwner(null, "payments"), "isLiveThreadSeatOwner: no owner is not a live thread seat");
eq(routeThreadMessage(OWNER, 3, "payments"), { kind: "task", token: OWNER, grain: "task" }, "matching domain ⇒ still routes the owner");
eq(routeThreadMessage(OWNER, 3, "treasury"), { kind: "standing" }, "a RE-HOMED domain (owner minted into another domain) ⇒ STANDING (stale, lazily reaped)");

console.log("2. ownership store round-trip:");
function fakeStore(): ThreadOwnershipStore & { rows: Map<string, { token: string; at: string }> } {
  const rows = new Map<string, { token: string; at: string }>();
  const k = (org: string, c: string, t: string) => `${org}\u0000${c}\u0000${t}`;
  return {
    rows,
    async putThreadOwner(org, channelKey, threadKey, taskToken, at, ttlMs) {
      const cutoff = new Date(Date.parse(at) - ttlMs).toISOString();
      for (const [key, v] of rows) if (key.startsWith(`${org}\u0000`) && v.at < cutoff) rows.delete(key);
      rows.set(k(org, channelKey, threadKey), { token: taskToken, at });
    },
    async getThreadOwner(org, channelKey, threadKey) {
      return rows.get(k(org, channelKey, threadKey))?.token ?? null;
    },
    async clearThreadOwner(org, channelKey, threadKey) {
      return rows.delete(k(org, channelKey, threadKey));
    },
  };
}

const store = fakeStore();
const ref = { channelKey: "slack/C1", threadKey: "170.5" };
ok((await resolveThreadOwner(store, "acme", ref)) === null, "a fresh thread has no owner");
await recordThreadOwner(store, "acme", ref, OWNER, "2026-07-15T10:00:00Z");
eq(await resolveThreadOwner(store, "acme", ref), OWNER, "recordThreadOwner then resolveThreadOwner returns the task token");
ok((await resolveThreadOwner(store, "globex", ref)) === null, "ownership is org-partitioned (another org sees no owner)");

const already = routeThreadMessage(await resolveThreadOwner(store, "acme", ref), 3);
eq(already, { kind: "task", token: OWNER, grain: "task" }, "a second spawn on an owned thread finds the existing live owner (reused, not re-minted)");

ok((await clearThreadOwner(store, "acme", ref)) === true, "clearThreadOwner removes the row");
ok((await resolveThreadOwner(store, "acme", ref)) === null, "after clear, the thread is unowned again");
eq(routeThreadMessage(await resolveThreadOwner(store, "acme", ref)), { kind: "standing" }, "after clear, an inbound message routes to the STANDING seat");
ok((await clearThreadOwner(store, "acme", ref)) === false, "clearing an already-cleared thread returns false");

const stale = fakeStore();
await recordThreadOwner(stale, "acme", ref, OWNER, "2026-01-01T00:00:00Z");
await stale.putThreadOwner("acme", "slack/C2", "999", taskTokenFor("slack/C2", "999", 3), new Date(Date.parse("2026-01-01T00:00:00Z") + THREAD_OWNER_TTL_MS + 1000).toISOString(), THREAD_OWNER_TTL_MS);
ok((await resolveThreadOwner(stale, "acme", ref)) === null, "an ownership row past its TTL is pruned on the next same-org write (bounded table)");

console.log("3. OPE-738 completer own-token guard (channel-less tool-execute contexts):");
const seatToken = formatWindowToken({ domain: "payments", windowId: threadSeatWindowId("slack/C9", "171.5"), generation: 3 });
const taskToken = taskTokenFor("slack/C9", "171.5", 3);
const standingToken = "oe-dom:payments:oe-sup:g3";
const execCtx = (windowToken: string | undefined, grain: string) =>
  ({
    session: { auth: { current: { attributes: { ...(windowToken === undefined ? {} : { oe_window_token: windowToken }), oe_grain: grain } } } },
  }) as never;

ok(isOwnTokenThreadSeat(execCtx(seatToken, "thread")), "complete_thread's guard says YES to a thread seat that carries only the host stamp (the live shape)");
ok(!isOwnTokenThreadSeat(execCtx(taskToken, "task")), "…and NO to a TASK worker's stamp (negative control — the guard is not answering yes to everything)");
ok(!isOwnTokenThreadSeat(execCtx(standingToken, "standing")), "…and NO to a STANDING window seat's stamp");
ok(!isOwnTokenThreadSeat(execCtx(undefined, "thread")), "…and NO when neither identity channel yields a token (fail-closed)");

const threadEntry = (await resolveWindowGated(completeThread, execCtx(seatToken, "thread"))) as {
  execute: (input: { summary?: string }, ctx: unknown) => Promise<unknown>;
};
ok(threadEntry !== null && typeof threadEntry?.execute === "function", "complete_thread RESOLVES on a channel-less thread-grain context");
await assert.rejects(
  () => threadEntry.execute({}, execCtx(seatToken, "thread")),
  /couldn't resolve this thread to release/,
  "complete_thread gets PAST its own-token guard on a real thread seat's context (it fails later, on the absent wake id)",
);
n++;
await assert.rejects(
  () => threadEntry.execute({}, execCtx(taskToken, "thread")),
  /only a thread seat can complete its thread/,
  "complete_thread still REFUSES a `thread` stamp sitting on a task token (the token, not the stamp, decides)",
);
n++;

console.log(`thread-ownership-test: ${n} assertions passed`);
